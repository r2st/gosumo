/**
 * Tests for the signed OAuth `state` token.
 *
 * The property under test is narrow but load-bearing: an OAuth callback is a
 * `@Public()` route, so whatever `state` says about which tenant the returned
 * credentials belong to is the entire authorization decision. These pin that a
 * state cannot be minted, edited, or replayed later by someone who did not
 * start the flow.
 */

import * as crypto from 'crypto';
import {
  signOAuthState,
  verifyOAuthState,
  OAUTH_STATE_TTL_MS,
} from './oauth-state.util';

const SECRET = 'test-jwt-secret-value';
const OTHER_SECRET = 'a-different-secret-value';
const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const VICTIM_ID = '00000000-0000-4000-a000-0000000000ff';

describe('signOAuthState', () => {
  it('round-trips the businessId', () => {
    const state = signOAuthState(BUSINESS_ID, SECRET);

    expect(verifyOAuthState(state, SECRET)).toBe(BUSINESS_ID);
  });

  it('does not leak the businessId as a bare substring', () => {
    // A caller that pattern-matched the old raw-id state would otherwise keep
    // working against the new token and skip verification entirely.
    expect(signOAuthState(BUSINESS_ID, SECRET)).not.toContain(BUSINESS_ID);
  });

  it('mints a different token each time for the same tenant', () => {
    const a = signOAuthState(BUSINESS_ID, SECRET);
    const b = signOAuthState(BUSINESS_ID, SECRET);

    expect(a).not.toBe(b);
    expect(verifyOAuthState(a, SECRET)).toBe(BUSINESS_ID);
    expect(verifyOAuthState(b, SECRET)).toBe(BUSINESS_ID);
  });

  it('refuses to mint without a secret rather than degrading to unsigned', () => {
    expect(() => signOAuthState(BUSINESS_ID, '')).toThrow(
      /without a secret/,
    );
  });
});

describe('verifyOAuthState', () => {
  it('rejects a bare businessId — the shape this replaced', () => {
    expect(verifyOAuthState(BUSINESS_ID, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = signOAuthState(VICTIM_ID, OTHER_SECRET);

    expect(verifyOAuthState(forged, SECRET)).toBeNull();
  });

  it('rejects a payload swapped for another tenant under a valid signature', () => {
    // The attack the signature exists to stop: take your own valid state,
    // re-point it at someone else's tenant, keep the signature.
    const mine = signOAuthState(BUSINESS_ID, SECRET);
    const [, signature] = mine.split('.');
    const swapped = Buffer.from(
      JSON.stringify({ b: VICTIM_ID, t: Date.now(), n: 'x' }),
    ).toString('base64url');

    expect(verifyOAuthState(`${swapped}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects a token whose signature is one character off', () => {
    const state = signOAuthState(BUSINESS_ID, SECRET);
    const flipped =
      state.slice(0, -1) + (state.endsWith('a') ? 'b' : 'a');

    expect(verifyOAuthState(flipped, SECRET)).toBeNull();
  });

  it('rejects a truncated signature without throwing', () => {
    // timingSafeEqual throws on a length mismatch — the length guard must run
    // first, or a short signature is a 500 instead of a rejection.
    const state = signOAuthState(BUSINESS_ID, SECRET);
    const [payload] = state.split('.');

    expect(verifyOAuthState(`${payload}.abc`, SECRET)).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a token with no separator', 'nodothere'],
    ['a token that is only a separator', '.'],
    ['a token with an empty payload', '.abcdef'],
  ])('rejects %s', (_label, state) => {
    expect(verifyOAuthState(state, SECRET)).toBeNull();
  });

  it('rejects a correctly-signed payload that is not JSON', () => {
    const payload = Buffer.from('not json at all').toString('base64url');
    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(payload)
      .digest('hex');

    expect(verifyOAuthState(`${payload}.${signature}`, SECRET)).toBeNull();
  });

  it.each([
    ['no businessId', { t: Date.now(), n: 'x' }],
    ['an empty businessId', { b: '', t: Date.now(), n: 'x' }],
    ['a non-string businessId', { b: 42, t: Date.now(), n: 'x' }],
    ['no timestamp', { b: BUSINESS_ID, n: 'x' }],
    ['a non-numeric timestamp', { b: BUSINESS_ID, t: 'soon', n: 'x' }],
  ])('rejects a correctly-signed payload with %s', (_label, body) => {
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', SECRET)
      .update(payload)
      .digest('hex');

    expect(verifyOAuthState(`${payload}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects a token past its TTL', () => {
    const issuedAt = 1_700_000_000_000;
    const state = signOAuthState(BUSINESS_ID, SECRET, issuedAt);

    expect(
      verifyOAuthState(
        state,
        SECRET,
        OAUTH_STATE_TTL_MS,
        issuedAt + OAUTH_STATE_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it('accepts a token at the last millisecond of its TTL', () => {
    const issuedAt = 1_700_000_000_000;
    const state = signOAuthState(BUSINESS_ID, SECRET, issuedAt);

    expect(
      verifyOAuthState(
        state,
        SECRET,
        OAUTH_STATE_TTL_MS,
        issuedAt + OAUTH_STATE_TTL_MS,
      ),
    ).toBe(BUSINESS_ID);
  });

  it('rejects a token stamped in the future', () => {
    const issuedAt = 1_700_000_000_000;
    const state = signOAuthState(BUSINESS_ID, SECRET, issuedAt);

    expect(
      verifyOAuthState(state, SECRET, OAUTH_STATE_TTL_MS, issuedAt - 1),
    ).toBeNull();
  });

  it('rejects everything when no secret is configured', () => {
    const state = signOAuthState(BUSINESS_ID, SECRET);

    expect(verifyOAuthState(state, '')).toBeNull();
  });
});
