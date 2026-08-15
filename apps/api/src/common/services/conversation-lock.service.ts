import { Injectable, Logger } from '@nestjs/common';

/**
 * How long a waiter will queue behind the turn in front of it before giving up
 * on the lock and running anyway.
 *
 * A realty turn is an LLM round-trip plus a handful of queries, so a healthy
 * turn is seconds. The ceiling exists only so a handler that hangs on something
 * with no deadline of its own cannot wedge a buyer's conversation forever.
 */
export const CONVERSATION_LOCK_TIMEOUT_MS = 60_000;

/**
 * ConversationLockService — runs work for one conversation one turn at a time,
 * in arrival order.
 *
 * ## The race this closes
 *
 * Every inbound message is announced as a single `message.received` event, and
 * `EventEmitter2.emit` does not await async listeners. So a buyer who sends
 * "2BHK in Wakad" and "budget 90L" a second apart has two listener invocations
 * running *concurrently* over the same conversation. Two things break:
 *
 *  - **Out-of-order replies.** Each turn is an independent LLM call, so
 *    whichever generation finishes first is delivered first. The answer to the
 *    second message can reach the buyer before the answer to the first.
 *
 *  - **Lost BLTC facts.** `RealtyAiService.processTurn` reads the lead's BLTC,
 *    merges this message's extraction into it in memory, then writes the merged
 *    profile back. Two turns that read the same starting profile each merge only
 *    their own message, and the second write clobbers the first: the budget the
 *    buyer just stated is gone, and the bot asks for it again.
 *
 * Serializing per conversation fixes both at once — the second turn starts from
 * the state the first one persisted, and its reply is sent after.
 *
 * ## Ordering guarantee
 *
 * Waiters are chained FIFO, so turns run in the order they called
 * {@link runExclusive} — which, for in-process event listeners, is the order the
 * messages arrived. A plain "is it free?" flag would give mutual exclusion but
 * not order, which fixes the merge race and leaves the out-of-order replies.
 *
 * ## Liveness over strictness
 *
 * A waiter blocks for at most {@link CONVERSATION_LOCK_TIMEOUT_MS}, then runs
 * regardless. A stuck predecessor therefore degrades one conversation back to
 * today's concurrent behaviour instead of silently freezing it forever, which is
 * the failure mode nobody would notice until a buyer complained.
 *
 * ## Where it is wired, and where it deliberately is not
 *
 * Held across the whole of each inbound path that reads state and writes it back:
 *
 *  - `ChannelAdapterService.handleInboundWebhook` — keyed per
 *    (channel account, sender), around persist-and-announce. Two webhook POSTs
 *    from one buyer otherwise both run find-or-create for the contact and the
 *    conversation, producing two OPEN conversations and splitting their history.
 *  - `AiEngineService.handleMessageReceived` — the whole generic pipeline.
 *  - `RealtyMessageBridgeService.handleMessageReceived` — the whole realty turn,
 *    which is where the BLTC merge race lives.
 *
 * The other `message.received` listeners are unlocked on purpose:
 *
 *  - `ClientIntelligenceService` writes only `last_interaction_at`. Two
 *    concurrent writes of "now" converge; there is no read to invalidate.
 *  - `CadenceEngineService.onInboundReply` stops reply-sensitive steps. Stopping
 *    an already-stopped enrolment is a no-op, so concurrent runs converge too.
 *  - `RealtyLeadsService.handleMessageReceived` *is* a find-or-create, but it is
 *    made safe by `uq_realty_leads_business_phone` plus a claim/revive/P2002
 *    retry rather than by this lock — see `client-identity.util.ts` for the same
 *    pattern on `clients`. That is the stronger guarantee: the constraint holds
 *    across processes, and this lock does not (below).
 *
 * ## Scope: this process only
 *
 * The chain lives in process memory, so it serializes turns handled by *this*
 * instance. That is the whole of production today (a single `gosumo.service`
 * on one host), and it is where the race actually happens: the batch loop and
 * the event bus are both in-process. Running the API multi-instance would need
 * this backed by a Redis lease keyed the same way — the call sites would not
 * change.
 */
@Injectable()
export class ConversationLockService {
  private readonly logger = new Logger(ConversationLockService.name);

  /**
   * key → tail of the chain of turns queued for it. The tail never rejects, so
   * a failed turn hands the lock to the next waiter instead of poisoning it.
   */
  private readonly chains = new Map<string, Promise<void>>();

  /** The lock key for a conversation. Tenant-scoped: ids are only unique within a business. */
  static conversationKey(businessId: string, conversationId: string): string {
    return `conversation:${businessId}:${conversationId}`;
  }

  /** The lock key for a realty lead, whose BLTC profile is the merged state. */
  static leadKey(businessId: string, leadId: string): string {
    return `lead:${businessId}:${leadId}`;
  }

  /** Number of keys currently held or queued — for tests and health output. */
  get activeKeys(): number {
    return this.chains.size;
  }

  /**
   * Run `fn` with exclusive access to `key`, after everything already queued for
   * it has finished.
   *
   * Rejections propagate to the caller unchanged: this controls *when* work
   * runs, never whether its failure is visible.
   */
  async runExclusive<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = CONVERSATION_LOCK_TIMEOUT_MS,
  ): Promise<T> {
    const predecessor = this.chains.get(key);

    // Wait for our turn — but never longer than the ceiling, and never fail
    // because the previous turn did.
    const gate = predecessor
      ? this.waitFor(predecessor, key, timeoutMs)
      : Promise.resolve();

    const result = gate.then(fn);

    // The tail must settle even when `fn` throws, or every later waiter for this
    // key inherits the rejection.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);

    // Drop the key once nothing is queued behind us, so the map does not grow
    // one entry per conversation for the life of the process. Only the current
    // tail may clear it — a later waiter has already replaced us by then.
    void tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });

    return result;
  }

  /**
   * Resolve when `predecessor` settles, or when the ceiling elapses — whichever
   * comes first. Never rejects.
   *
   * The timer is cleared on the normal path so a queue of quick turns does not
   * leave one pending timer each, and `unref`'d so a waiting lock can never be
   * the reason the process refuses to exit on shutdown.
   */
  private waitFor(
    predecessor: Promise<void>,
    key: string,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn(
          `Conversation lock "${key}" held longer than ${timeoutMs}ms — ` +
            `proceeding without it; turns for this conversation may interleave`,
        );
        resolve();
      }, timeoutMs);

      // `unref` is Node-only; guard it so the service stays usable under any
      // timer implementation a test might install.
      if (typeof timer.unref === 'function') timer.unref();

      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      predecessor.then(done, done);
    });
  }
}
