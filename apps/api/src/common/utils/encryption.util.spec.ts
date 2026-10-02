/**
 * Channel-credential encryption + masking unit tests.
 *
 * `maskCredentialFields` is what the channels API returns to the dashboard, so
 * every branch here decides whether a secret leaks. The masked shape must never
 * reveal a short secret at all (a 3-character token is entirely its own last4),
 * and an unset field must not report a `value`.
 */

import {
  assertChannelEncryptionKey,
  channelKeySource,
  encryptJson,
  decryptJson,
  FALLBACK_CHANNEL_KEY,
  maskCredentialFields,
  MIN_CHANNEL_KEY_LENGTH,
} from './encryption.util';

describe('encryptJson / decryptJson', () => {
  it('round-trips an object through AES-256-GCM', () => {
    const secret = { accessToken: 'abc123', phoneNumberId: '55512345' };
    const blob = encryptJson(secret);

    expect(blob).not.toContain('abc123');
    expect(decryptJson(blob)).toEqual(secret);
  });

  it('falls back to plain JSON for pre-encryption rows', () => {
    expect(decryptJson(JSON.stringify({ apiKey: 'legacy' }))).toEqual({ apiKey: 'legacy' });
  });

  it('returns an empty object for undecryptable garbage rather than throwing', () => {
    expect(decryptJson('not-base64-and-not-json')).toEqual({});
  });

  it('logs a warning via NestJS Logger (not console) on decryption failure', () => {
    const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    decryptJson('unrecoverable-garbage-value');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decrypt or parse credential'),
    );
    expect(consoleSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('maskCredentialFields', () => {
  it('reveals only the last 4 characters of a secret-looking field', () => {
    expect(maskCredentialFields({ accessToken: 'EAAGm0PX4ZCpsBO1234' })).toEqual({
      accessToken: { set: true, last4: '1234' },
    });
  });

  it('omits last4 for a secret shorter than 4 characters', () => {
    // Showing "last 4" of a 3-char secret would print the whole secret.
    expect(maskCredentialFields({ apiSecret: 'abc' })).toEqual({
      apiSecret: { set: true },
    });
  });

  it('reports an empty secret as unset with no last4', () => {
    expect(maskCredentialFields({ clientSecret: '' })).toEqual({
      clientSecret: { set: false },
    });
  });

  it('reports a null secret as unset with no last4', () => {
    expect(maskCredentialFields({ webhookToken: null })).toEqual({
      webhookToken: { set: false },
    });
  });

  it('shows non-secret fields in the clear', () => {
    expect(maskCredentialFields({ phoneNumberId: '15551234567' })).toEqual({
      phoneNumberId: { set: true, value: '15551234567' },
    });
  });

  it('leaves an unset non-secret field without a value', () => {
    expect(maskCredentialFields({ phoneNumberId: '' })).toEqual({
      phoneNumberId: { set: false, value: undefined },
    });
  });

  it('stringifies non-string values before masking', () => {
    expect(maskCredentialFields({ pageId: 987654321 })).toEqual({
      pageId: { set: true, value: '987654321' },
    });
  });

  it('treats a numeric zero as unset — String(0) is truthy but the value is not', () => {
    expect(maskCredentialFields({ pageId: 0 })).toEqual({
      pageId: { set: false, value: undefined },
    });
  });

  it('masks every secret-shaped field name case-insensitively', () => {
    const masked = maskCredentialFields({
      ACCESS_TOKEN: 'aaaabbbbcccc',
      Password: 'hunter2xyz',
      refreshToken: 'rrrrsssstttt',
    });

    expect(masked.ACCESS_TOKEN).toEqual({ set: true, last4: 'cccc' });
    expect(masked.Password).toEqual({ set: true, last4: '2xyz' });
    expect(masked.refreshToken).toEqual({ set: true, last4: 'tttt' });
  });
});

/**
 * Key-source classification.
 *
 * `deriveKey` falls through three sources without saying which one it used, and
 * two of the three are wrong for production. These assert the classification
 * itself; `main.spec.ts` covers what the bootstrap does with the verdict.
 */
describe('channelKeySource', () => {
  it('reports an explicitly configured key', () => {
    expect(channelKeySource({ CHANNEL_ENCRYPTION_KEY: 'k', JWT_SECRET: 'j' })).toBe('explicit');
  });

  it('reports the JWT_SECRET fallback', () => {
    expect(channelKeySource({ JWT_SECRET: 'j' })).toBe('jwt-secret');
  });

  it('reports the built-in constant when nothing is set', () => {
    expect(channelKeySource({})).toBe('built-in-default');
  });

  it('treats an empty string as unset', () => {
    // `FOO=` in an env file is the shape this actually arrives in, and the ||
    // chain in deriveKey skips it — the classification has to agree, or the
    // check would clear a deployment that is in fact using the fallback.
    expect(channelKeySource({ CHANNEL_ENCRYPTION_KEY: '', JWT_SECRET: 'j' })).toBe('jwt-secret');
    expect(channelKeySource({ CHANNEL_ENCRYPTION_KEY: '', JWT_SECRET: '' })).toBe(
      'built-in-default',
    );
  });
});

describe('assertChannelEncryptionKey', () => {
  const prod = (env: NodeJS.ProcessEnv) => assertChannelEncryptionKey(env, true);
  const dev = (env: NodeJS.ProcessEnv) => assertChannelEncryptionKey(env, false);

  it('is fatal in production when the built-in constant would be used', () => {
    const check = prod({});
    expect(check.severity).toBe('fatal');
    expect(check.source).toBe('built-in-default');
  });

  it('quotes the constant so the reader can see it is not a secret', () => {
    expect(prod({}).message).toContain(FALLBACK_CHANNEL_KEY);
  });

  it('warns — but does not block — on the JWT_SECRET fallback', () => {
    // An existing deployment runs this way. Refusing to boot would take a
    // working service down to fix a latent risk, which is the wrong trade.
    const check = prod({ JWT_SECRET: 'j'.repeat(48) });
    expect(check.severity).toBe('warn');
    expect(check.source).toBe('jwt-secret');
  });

  it('warns on an explicit key with little entropy behind it', () => {
    const check = prod({ CHANNEL_ENCRYPTION_KEY: 'x'.repeat(MIN_CHANNEL_KEY_LENGTH - 1) });
    expect(check.severity).toBe('warn');
    expect(check.source).toBe('explicit');
  });

  it('accepts an explicit key at exactly the minimum length', () => {
    // The boundary is inclusive; a key of exactly the documented length must
    // not warn, or the advice and the check disagree.
    const check = prod({ CHANNEL_ENCRYPTION_KEY: 'x'.repeat(MIN_CHANNEL_KEY_LENGTH) });
    expect(check).toEqual({ source: 'explicit', severity: 'ok', message: null });
  });

  it('says nothing outside production, whatever the key situation', () => {
    for (const env of [{}, { JWT_SECRET: 'j' }, { CHANNEL_ENCRYPTION_KEY: 'k' }]) {
      expect(dev(env).severity).toBe('ok');
      expect(dev(env).message).toBeNull();
    }
  });

  it('derives production from NODE_ENV when not told', () => {
    expect(assertChannelEncryptionKey({ NODE_ENV: 'production' }).severity).toBe('fatal');
    expect(assertChannelEncryptionKey({ NODE_ENV: 'development' }).severity).toBe('ok');
    expect(assertChannelEncryptionKey({}).severity).toBe('ok');
  });
});

/**
 * The property that makes the warning above necessary: a key change is not an
 * error, it is silence.
 */
describe('re-keying is undetectable at the decryption boundary', () => {
  const originalKey = process.env.CHANNEL_ENCRYPTION_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.CHANNEL_ENCRYPTION_KEY;
    else process.env.CHANNEL_ENCRYPTION_KEY = originalKey;
  });

  it('returns an empty object rather than throwing when the key has changed', () => {
    process.env.CHANNEL_ENCRYPTION_KEY = 'first-key-'.repeat(4);
    const ciphertext = encryptJson({ accessToken: 'live-token' });

    process.env.CHANNEL_ENCRYPTION_KEY = 'second-key-'.repeat(4);

    // No exception, no signal — the credential simply reads back as absent.
    // This is why rotating JWT_SECRET while it doubles as the channel key is
    // worth a startup warning rather than a footnote.
    expect(decryptJson(ciphertext)).toEqual({});
  });
});
