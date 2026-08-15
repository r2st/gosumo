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
    expect(resolveCorsOrigin('https://a.example,')).toEqual(['https://a.example']);
  });

  it('leaves the wildcard alone', () => {
    expect(resolveCorsOrigin('*')).toBe('*');
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
});
