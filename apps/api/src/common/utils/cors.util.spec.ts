import { allowCredentials, corsOptionsFor, resolveCorsOrigin } from './cors.util';

describe('resolveCorsOrigin', () => {
  it('passes a single origin through', () => {
    expect(resolveCorsOrigin('https://gosumo.aiknol.com')).toBe('https://gosumo.aiknol.com');
  });

  it('splits a comma-separated list and trims it', () => {
    expect(resolveCorsOrigin('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('drops empty entries left by a trailing comma', () => {
    // One surviving origin is a plain string, not a one-element list: the
    // `cors` package serves a fixed string as a constant header and only takes
    // the reflect-the-request-origin path for a list, so the simpler shape is
    // the one to hand it.
    expect(resolveCorsOrigin('https://a.example,')).toBe('https://a.example');
  });

  it('leaves the wildcard alone', () => {
    expect(resolveCorsOrigin('*')).toBe('*');
  });

  it('trims a single origin', () => {
    // An untrimmed origin never string-equals a real `Origin` header, so every
    // cross-origin request is refused while the allow-list looks correct.
    expect(resolveCorsOrigin('  https://gosumo.aiknol.com ')).toBe(
      'https://gosumo.aiknol.com',
    );
  });

  it('falls back to the wildcard when the value is set but empty', () => {
    // `CORS_ORIGIN=` is a string, so `?? '*'` never substitutes the default and
    // the raw `''` reached the CORS layer. See the credentials test below for
    // why that mattered.
    expect(resolveCorsOrigin('')).toBe('*');
  });

  it('falls back to the wildcard when the value is only separators', () => {
    expect(resolveCorsOrigin(' , , ')).toBe('*');
  });
});

describe('allowCredentials', () => {
  it('is false for the wildcard — the one combination browsers refuse', () => {
    expect(allowCredentials('*')).toBe(false);
  });

  it('is true for a named origin', () => {
    expect(allowCredentials('https://gosumo.aiknol.com')).toBe(true);
  });

  it('is true for a list of named origins', () => {
    expect(allowCredentials(['https://a.example', 'https://b.example'])).toBe(true);
  });
});

describe('corsOptionsFor', () => {
  it('never emits wildcard-plus-credentials', () => {
    expect(corsOptionsFor('*')).toEqual({ origin: '*', credentials: false });
  });

  it('turns credentials on once real origins are named', () => {
    expect(corsOptionsFor('https://shop.example, https://www.shop.example')).toEqual({
      origin: ['https://shop.example', 'https://www.shop.example'],
      credentials: true,
    });
  });

  it('never emits wildcard-plus-credentials for an empty env var either', () => {
    // The regression this pins: `''` is not the literal `*`, so
    // `allowCredentials` saw a named origin and returned true — while the
    // `cors` package treats *any* falsy origin as `*` and sent the wildcard.
    // The forbidden pairing, arrived at through the back door, and silent
    // because `main.ts` only warns on a literal `*`.
    expect(corsOptionsFor('')).toEqual({ origin: '*', credentials: false });
  });

  it('does not let a stray separator become wildcard-plus-credentials', () => {
    expect(corsOptionsFor(' , ')).toEqual({ origin: '*', credentials: false });
  });

  it('keeps credentials on for a trimmed single origin', () => {
    expect(corsOptionsFor('  https://gosumo.aiknol.com  ')).toEqual({
      origin: 'https://gosumo.aiknol.com',
      credentials: true,
    });
  });
});
