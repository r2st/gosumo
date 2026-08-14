/**
 * Channel-credential encryption + masking unit tests.
 *
 * `maskCredentialFields` is what the channels API returns to the dashboard, so
 * every branch here decides whether a secret leaks. The masked shape must never
 * reveal a short secret at all (a 3-character token is entirely its own last4),
 * and an unset field must not report a `value`.
 */

import {
  encryptJson,
  decryptJson,
  maskCredentialFields,
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
