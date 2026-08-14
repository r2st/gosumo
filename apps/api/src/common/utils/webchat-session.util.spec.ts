import * as crypto from 'crypto';
import { ConfigurationError } from '@gosumo/shared';
import {
  signWebChatSession,
  verifyWebChatSession,
  WEBCHAT_SESSION_TTL_MS,
} from './webchat-session.util';

const SECRET = 'a-webchat-signing-secret';
const WIDGET = '00000000-0000-4000-a000-000000000002';
const OTHER_WIDGET = '00000000-0000-4000-a000-000000000009';
const NOW = Date.parse('2026-08-14T12:00:00.000Z');

describe('webchat-session.util', () => {
  describe('signWebChatSession', () => {
    it('round-trips the session id and widget it was minted for', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW);

      expect(verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW)).toEqual({
        sessionId: 'sess-1',
        widgetId: WIDGET,
      });
    });

    it('generates a session id when none is supplied', () => {
      const t = signWebChatSession(WIDGET, SECRET, undefined, NOW);

      const session = verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW);
      expect(session?.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('mints a distinct token per session id', () => {
      const a = signWebChatSession(WIDGET, SECRET, 'sess-a', NOW);
      const b = signWebChatSession(WIDGET, SECRET, 'sess-b', NOW);

      expect(a).not.toBe(b);
    });

    it('refuses to mint without a secret rather than degrading to a forgeable token', () => {
      expect(() => signWebChatSession(WIDGET, '', 'sess-1', NOW)).toThrow(ConfigurationError);
    });

    it('names the config key it needs so the deployment failure is actionable', () => {
      expect(() => signWebChatSession(WIDGET, '', 'sess-1', NOW)).toThrow(
        expect.objectContaining({ configKey: 'JWT_SECRET' }),
      );
    });
  });

  describe('verifyWebChatSession', () => {
    it('rejects a token signed with a different secret', () => {
      const forged = signWebChatSession(WIDGET, 'attacker-secret', 'sess-1', NOW);

      expect(verifyWebChatSession(forged, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW)).toBeNull();
    });

    it('rejects a tampered payload that keeps the original signature', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW);
      const [, signature] = t.split('.');
      const swapped = Buffer.from(
        JSON.stringify({ s: 'victim-session', w: WIDGET, t: NOW }),
      ).toString('base64url');

      expect(
        verifyWebChatSession(
          `${swapped}.${signature}`,
          SECRET,
          WIDGET,
          WEBCHAT_SESSION_TTL_MS,
          NOW,
        ),
      ).toBeNull();
    });

    it('rejects a raw session id presented as a token', () => {
      expect(
        verifyWebChatSession('victim-session', SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW),
      ).toBeNull();
    });

    it('rejects a token minted for another widget', () => {
      // The signature is ours, so only the bound widget id stops a token
      // collected from one tenant's site resuming against another's.
      const t = signWebChatSession(OTHER_WIDGET, SECRET, 'sess-1', NOW);

      expect(verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW)).toBeNull();
    });

    it('accepts a token for any widget when no widget is named', () => {
      const t = signWebChatSession(OTHER_WIDGET, SECRET, 'sess-1', NOW);

      expect(
        verifyWebChatSession(t, SECRET, undefined, WEBCHAT_SESSION_TTL_MS, NOW),
      ).toEqual({ sessionId: 'sess-1', widgetId: OTHER_WIDGET });
    });

    it('accepts a token on the last millisecond of its lifetime', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW);
      const at = NOW + WEBCHAT_SESSION_TTL_MS;

      expect(verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, at)).not.toBeNull();
    });

    it('rejects a token one millisecond past its lifetime', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW);
      const at = NOW + WEBCHAT_SESSION_TTL_MS + 1;

      expect(verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, at)).toBeNull();
    });

    it('rejects a token stamped in the future', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW + 60_000);

      expect(verifyWebChatSession(t, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW)).toBeNull();
    });

    it.each([
      ['an empty token', ''],
      ['a token with no separator', 'abcdef'],
      ['a token that is only a signature', '.abcdef'],
      ['a token whose payload is not base64url JSON', 'not-json.abcdef'],
    ])('rejects %s', (_label, value) => {
      expect(
        verifyWebChatSession(value, SECRET, WIDGET, WEBCHAT_SESSION_TTL_MS, NOW),
      ).toBeNull();
    });

    it('rejects a valid token when no secret is configured', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-1', NOW);

      expect(verifyWebChatSession(t, '', WIDGET, WEBCHAT_SESSION_TTL_MS, NOW)).toBeNull();
    });

    it.each([
      ['a missing session id', { w: WIDGET, t: NOW }],
      ['an empty session id', { s: '', w: WIDGET, t: NOW }],
      ['a non-string session id', { s: 42, w: WIDGET, t: NOW }],
      ['a missing widget id', { s: 'sess-1', t: NOW }],
      ['an empty widget id', { s: 'sess-1', w: '', t: NOW }],
      ['a missing timestamp', { s: 'sess-1', w: WIDGET }],
      ['a non-numeric timestamp', { s: 'sess-1', w: WIDGET, t: 'soon' }],
      ['a non-finite timestamp', { s: 'sess-1', w: WIDGET, t: Infinity }],
    ])('rejects a correctly-signed payload with %s', (_label, payload) => {
      // Signed with the real secret, so only the shape checks stand in the way.
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = crypto
        .createHmac('sha256', SECRET)
        .update(payloadB64)
        .digest('hex');

      expect(
        verifyWebChatSession(
          `${payloadB64}.${signature}`,
          SECRET,
          WIDGET,
          WEBCHAT_SESSION_TTL_MS,
          NOW,
        ),
      ).toBeNull();
    });

    it('defaults to a 24 hour lifetime', () => {
      expect(WEBCHAT_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('uses the default TTL and clock when neither is supplied', () => {
      const t = signWebChatSession(WIDGET, SECRET, 'sess-now');

      expect(verifyWebChatSession(t, SECRET, WIDGET)).toEqual({
        sessionId: 'sess-now',
        widgetId: WIDGET,
      });
    });
  });
});
