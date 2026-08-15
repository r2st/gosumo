/**
 * The web-chat outbox — the hand-off between `WebChatAdapter` (which produces
 * outbound replies and has no socket) and `WebChatGateway` (which holds the
 * sockets and never hears about a reply).
 *
 * What these pin down is the gap that used to sit between them. The adapter
 * pushed every reply into `webchatResponseMap`, and the only code that removed
 * anything from it — `WebChatGateway.deliverPendingMessages()` — was called by
 * nothing in the application: no timer, no event listener, no caller. So two
 * things were true at once and neither was visible:
 *
 *   - a web-chat visitor never received an AI reply, because nothing ever
 *     emitted it over their socket; and
 *   - the text of every one of those replies stayed in a process-global Map
 *     for the life of the process, growing one entry per visitor per reply.
 *
 * Both are covered here: the sink that makes delivery happen, and the three
 * ceilings (per-session, per-process, and age) that bound whatever cannot be
 * delivered.
 */

import { ConfigService } from '@nestjs/config';
import { MessageContentType } from '@gosumo/shared';
import {
  WebChatAdapter,
  WEBCHAT_OUTBOX_MAX_PER_SESSION,
  WEBCHAT_OUTBOX_MAX_SESSIONS,
  WEBCHAT_OUTBOX_TTL_MS,
  enqueueWebChatResponse,
  evictStaleWebChatResponses,
  setWebChatDeliverySink,
  webchatResponseMap,
} from './webchat.adapter';

const SESSION_ID = 'session-outbox-1';
const WIDGET_ID = 'widget-outbox-1';

/** A message stamped at `at`, so TTL behaviour is testable without fake timers. */
function messageAt(id: string, at: number, text = id) {
  return { id, text, timestamp: new Date(at) };
}

describe('web-chat outbox', () => {
  afterEach(() => {
    setWebChatDeliverySink(null);
    webchatResponseMap.clear();
  });

  // ─────────────────────────────────────────────
  // The sink — what makes a buffer a buffer
  // ─────────────────────────────────────────────

  describe('delivery sink', () => {
    it('notifies the sink with the session a reply was buffered for', () => {
      const sink = jest.fn();
      setWebChatDeliverySink(sink);

      enqueueWebChatResponse(SESSION_ID, messageAt('m1', 1_000));

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(SESSION_ID);
    });

    it('retains nothing when the sink drains the session', () => {
      setWebChatDeliverySink((sessionId) => {
        webchatResponseMap.delete(sessionId);
      });

      enqueueWebChatResponse(SESSION_ID, messageAt('m1', 1_000));

      // The connected-visitor path: emitted and gone before the send returns.
      expect(webchatResponseMap.has(SESSION_ID)).toBe(false);
    });

    it('holds the reply when no sink is registered', () => {
      enqueueWebChatResponse(SESSION_ID, messageAt('m1', 1_000));

      expect(webchatResponseMap.get(SESSION_ID)).toHaveLength(1);
    });

    it('buffers the reply anyway when the sink throws', () => {
      setWebChatDeliverySink(() => {
        throw new Error('socket exploded mid-emit');
      });

      // The adapter has already told the AI pipeline the send succeeded; a
      // delivery fault must not turn into a thrown send.
      expect(() =>
        enqueueWebChatResponse(SESSION_ID, messageAt('m1', 1_000)),
      ).not.toThrow();
      expect(webchatResponseMap.get(SESSION_ID)).toHaveLength(1);
    });

    it('stops notifying once the sink is cleared', () => {
      const sink = jest.fn();
      setWebChatDeliverySink(sink);
      setWebChatDeliverySink(null);

      enqueueWebChatResponse(SESSION_ID, messageAt('m1', 1_000));

      expect(sink).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Ceilings — what stops undeliverable replies leaking
  // ─────────────────────────────────────────────

  describe('per-session ceiling', () => {
    it('keeps the newest replies and drops the oldest past the cap', () => {
      const total = WEBCHAT_OUTBOX_MAX_PER_SESSION + 5;
      for (let i = 0; i < total; i += 1) {
        enqueueWebChatResponse(SESSION_ID, messageAt(`m${i}`, 1_000 + i), 1_000 + i);
      }

      const pending = webchatResponseMap.get(SESSION_ID);
      expect(pending).toHaveLength(WEBCHAT_OUTBOX_MAX_PER_SESSION);
      // A visitor returning wants the end of the conversation, not its start.
      expect(pending?.[0]?.id).toBe('m5');
      expect(pending?.[pending.length - 1]?.id).toBe(`m${total - 1}`);
    });
  });

  describe('age ceiling', () => {
    it('drops sessions whose newest reply has aged out', () => {
      // Seeded directly: `enqueueWebChatResponse` evicts as it goes, which is
      // the point of the next test but would do this one's work for it.
      webchatResponseMap.set('stale', [messageAt('old', 0)]);
      webchatResponseMap.set('fresh', [messageAt('new', WEBCHAT_OUTBOX_TTL_MS)]);

      const dropped = evictStaleWebChatResponses(WEBCHAT_OUTBOX_TTL_MS + 1);

      expect(dropped).toBe(1);
      expect(webchatResponseMap.has('stale')).toBe(false);
      expect(webchatResponseMap.has('fresh')).toBe(true);
    });

    it('keeps a session alive while any reply in it is inside the window', () => {
      webchatResponseMap.set('mixed', [
        messageAt('old', 0),
        messageAt('recent', WEBCHAT_OUTBOX_TTL_MS),
      ]);

      evictStaleWebChatResponses(WEBCHAT_OUTBOX_TTL_MS + 1);

      expect(webchatResponseMap.has('mixed')).toBe(true);
    });

    it('drops an empty session buffer rather than holding the key forever', () => {
      webchatResponseMap.set('drained', []);

      evictStaleWebChatResponses(1_000);

      expect(webchatResponseMap.has('drained')).toBe(false);
    });

    it('runs on every enqueue, so a live process never accumulates dead sessions', () => {
      enqueueWebChatResponse('stale', messageAt('old', 0), 0);

      enqueueWebChatResponse(
        'current',
        messageAt('now', WEBCHAT_OUTBOX_TTL_MS + 1),
        WEBCHAT_OUTBOX_TTL_MS + 1,
      );

      expect(webchatResponseMap.has('stale')).toBe(false);
      expect(webchatResponseMap.has('current')).toBe(true);
    });
  });

  describe('process ceiling', () => {
    it('sheds the coldest sessions when the map is over its size cap', () => {
      // All within the TTL, so age alone frees nothing — the size cap is the
      // only thing standing between this and unbounded growth.
      const base = 1_000_000;
      for (let i = 0; i < WEBCHAT_OUTBOX_MAX_SESSIONS + 10; i += 1) {
        webchatResponseMap.set(`s${i}`, [messageAt(`m${i}`, base + i)]);
      }

      const dropped = evictStaleWebChatResponses(base + WEBCHAT_OUTBOX_MAX_SESSIONS + 10);

      expect(dropped).toBe(10);
      expect(webchatResponseMap.size).toBe(WEBCHAT_OUTBOX_MAX_SESSIONS);
      // The ten least recently active went; the newest stayed.
      expect(webchatResponseMap.has('s0')).toBe(false);
      expect(webchatResponseMap.has('s9')).toBe(false);
      expect(webchatResponseMap.has('s10')).toBe(true);
      expect(webchatResponseMap.has(`s${WEBCHAT_OUTBOX_MAX_SESSIONS + 9}`)).toBe(true);
    });

    it('leaves a map inside the cap untouched', () => {
      const base = 1_000_000;
      webchatResponseMap.set('a', [messageAt('m', base)]);
      webchatResponseMap.set('b', [messageAt('m', base)]);

      expect(evictStaleWebChatResponses(base)).toBe(0);
      expect(webchatResponseMap.size).toBe(2);
    });
  });

  // ─────────────────────────────────────────────
  // The adapter's own send path goes through all of it
  // ─────────────────────────────────────────────

  describe('WebChatAdapter.sendMessage', () => {
    let adapter: WebChatAdapter;

    beforeEach(() => {
      adapter = new WebChatAdapter({
        get: jest.fn().mockReturnValue(''),
      } as unknown as ConfigService);
    });

    it('pushes through the outbox, so the sink sees every reply', async () => {
      const sink = jest.fn();
      setWebChatDeliverySink(sink);

      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: { type: MessageContentType.TEXT, text: 'we have three 2BHKs' },
      });

      expect(sink).toHaveBeenCalledWith(SESSION_ID);
    });

    it('reports success even when delivery is impossible', async () => {
      const result = await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: 'nobody-is-listening',
        content: { type: MessageContentType.TEXT, text: 'held for later' },
      });

      expect(result.success).toBe(true);
      expect(webchatResponseMap.get('nobody-is-listening')).toHaveLength(1);
    });
  });
});
