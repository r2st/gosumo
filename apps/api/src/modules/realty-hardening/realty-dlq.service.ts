import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, DeadLetterStatus } from '@prisma/client';
import type { realty_dead_letters } from '@prisma/client';
import { RealtyDlqRepository, ListDeadLettersFilter } from './realty-dlq.repository';
import {
  DEFAULT_RETRY_POLICY,
  DLQ_MAX_REPLAYS,
  REALTY_HARDENING_EVENTS,
  RetryPolicy,
} from './realty-hardening.constants';

/** Identity + provenance of a realty operation the DLQ protects. */
export interface DeadLetterMeta {
  source: string;
  operation: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
}

/**
 * A dead letter as it leaves this service — every column except `error_stack`.
 *
 * The stack is still written on capture, because it is what we debug from. It
 * just never crosses back out: `list`, `get`, `replay`, and `resolve` are all
 * returned straight to the client by `RealtyHardeningController` with no DTO in
 * between, so a raw row put a full Node trace — absolute `/opt/gosumo/...`
 * paths, the internal module layout, the `node_modules` frames of whatever
 * failed — on the wire for any authenticated user of the business. `list` did
 * it for every parked entry at once.
 *
 * Redacting here rather than in the controller is what makes it hold: this is
 * the boundary every route goes through, so a route added later inherits it
 * instead of having to remember it.
 */
export type RedactedDeadLetter = Omit<realty_dead_letters, 'error_stack'>;

/** Strip the stack from a row on its way out of this service. */
function redact(entry: realty_dead_letters): RedactedDeadLetter {
  const { error_stack: _errorStack, ...rest } = entry;
  return rest;
}

/**
 * A function that re-executes a captured operation from its stored payload.
 *
 * `entry` is redacted like every other read — no registered replayer reads the
 * stack, and a handler is not a reason to reconstitute it.
 */
export type ReplayHandler = (
  businessId: string,
  payload: Record<string, unknown>,
  entry: RedactedDeadLetter,
) => Promise<void>;

export interface RunWithRetryOptions {
  policy?: Partial<RetryPolicy>;
  /** Injectable sleeper so tests don't wait real time. */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * When true, a final failure is captured to the DLQ and swallowed (returns
   * null) so the caller degrades gracefully; when false (default) it rethrows
   * after capture.
   */
  swallow?: boolean;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RealtyDlqService — the retry + dead-letter backbone for realty async work
 * (Phase 7). Two roles:
 *
 * 1. `runWithRetry` wraps a fallible operation with bounded exponential-backoff
 *    retries; on final failure it captures the job (never drops it) to the
 *    append-only-ish `realty_dead_letters` table so nothing is silently lost
 *    during the unattended soak.
 * 2. `replay` re-executes a captured job through a handler registered by its
 *    owning module (`registerReplayer`), advancing its status to REPLAYED.
 *
 * Capture is best-effort at the persistence layer but always attempted; a DLQ
 * write failure is logged, never thrown into the caller's happy path.
 */
@Injectable()
export class RealtyDlqService {
  private readonly logger = new Logger(RealtyDlqService.name);
  private readonly replayers = new Map<string, ReplayHandler>();

  constructor(
    private readonly repository: RealtyDlqRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Register the function that knows how to re-run `operation`. Modules that
   * produce dead letters call this in `onModuleInit`. Idempotent (last wins).
   */
  registerReplayer(operation: string, handler: ReplayHandler): void {
    this.replayers.set(operation, handler);
  }

  /**
   * Run `fn` with bounded retries. Returns its value on success. On exhausting
   * retries, captures a dead letter and either rethrows (default) or returns
   * null (`swallow: true`) for graceful degradation.
   */
  async runWithRetry<T>(
    businessId: string,
    meta: DeadLetterMeta,
    fn: () => Promise<T>,
    options: RunWithRetryOptions = {},
  ): Promise<T | null> {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...(options.policy ?? {}) };
    const sleep = options.sleepFn ?? realSleep;
    const attempts = Math.max(1, policy.attempts);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < attempts) {
          const backoff = Math.min(
            policy.maxBackoffMs,
            policy.backoffMs * 2 ** (attempt - 1),
          );
          this.logger.warn(
            `Realty op ${meta.source}/${meta.operation} failed (attempt ${attempt}/${attempts}); retrying in ${backoff}ms: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await sleep(backoff);
        }
      }
    }

    await this.capture(businessId, meta, lastErr, attempts);
    if (options.swallow) return null;
    throw lastErr;
  }

  /** Persist a failed operation to the DLQ. Never throws. */
  async capture(
    businessId: string,
    meta: DeadLetterMeta,
    error: unknown,
    attempts: number,
  ): Promise<realty_dead_letters | null> {
    try {
      const entry = await this.repository.create({
        businessId,
        source: meta.source,
        operation: meta.operation,
        payload: (meta.payload ?? {}) as Prisma.InputJsonValue,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
        attempts,
        correlationId: meta.correlationId ?? null,
        leadId: meta.leadId ?? null,
        conversationId: meta.conversationId ?? null,
      });
      this.logger.error(
        `Dead-lettered ${meta.source}/${meta.operation} for business ${businessId} → ${entry.id}`,
      );
      this.eventEmitter.emit(REALTY_HARDENING_EVENTS.DEAD_LETTER_CAPTURED, {
        businessId,
        deadLetterId: entry.id,
        source: meta.source,
        operation: meta.operation,
      });
      return entry;
    } catch (persistErr) {
      // Last-resort: we could not even record the failure. Log loudly.
      this.logger.error(
        `CRITICAL: failed to persist dead letter for ${meta.source}/${meta.operation}: ${
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        }`,
      );
      return null;
    }
  }

  async list(
    businessId: string,
    filter: ListDeadLettersFilter = {},
  ): Promise<RedactedDeadLetter[]> {
    const rows = await this.repository.list(businessId, filter);
    return rows.map(redact);
  }

  async get(businessId: string, id: string): Promise<RedactedDeadLetter> {
    const entry = await this.repository.findById(businessId, id);
    if (!entry) throw new NotFoundException(`Dead letter ${id} not found`);
    return redact(entry);
  }

  /**
   * Re-execute a captured job through its registered replayer. On success the
   * entry becomes REPLAYED; on failure its attempt count is bumped and it stays
   * PENDING (until it exhausts `DLQ_MAX_REPLAYS`, after which it is DISCARDED).
   */
  async replay(businessId: string, id: string): Promise<RedactedDeadLetter> {
    const entry = await this.get(businessId, id);
    if (entry.status === DeadLetterStatus.REPLAYED) {
      return entry; // idempotent — already recovered
    }
    if (entry.status !== DeadLetterStatus.PENDING) {
      throw new NotFoundException(`Dead letter ${id} is ${entry.status}, not replayable`);
    }

    const handler = this.replayers.get(entry.operation);
    if (!handler) {
      throw new NotFoundException(
        `No replayer registered for operation "${entry.operation}"`,
      );
    }

    // Claim the entry before running anything. The status check above is a
    // read, so two replays of the same id — two operators on the ops screen, a
    // double-submit, a retried request — both passed it and both invoked the
    // handler. Replaying a captured operation twice is the one thing a DLQ must
    // not do: the payloads it holds are sends and pushes that already have a
    // chance of having landed the first time.
    const claimed = await this.repository.claimForReplay(
      businessId,
      id,
      entry.attempts,
    );
    if (!claimed) {
      throw new ConflictException(
        `Dead letter ${id} is already being replayed — reload and retry`,
      );
    }
    // The claim consumed an attempt, so failure bookkeeping below counts from
    // here rather than incrementing again.
    const attempts = entry.attempts + 1;

    try {
      await handler(businessId, this.readPayload(entry), entry);
      const updated = await this.repository.update(businessId, id, {
        status: DeadLetterStatus.REPLAYED,
        replayed_at: new Date(),
      });
      this.eventEmitter.emit(REALTY_HARDENING_EVENTS.DEAD_LETTER_REPLAYED, {
        businessId,
        deadLetterId: id,
        operation: entry.operation,
      });
      this.logger.log(`Replayed dead letter ${id} (${entry.operation})`);
      return redact(updated);
    } catch (err) {
      const exhausted = attempts - DEFAULT_RETRY_POLICY.attempts >= DLQ_MAX_REPLAYS;
      const updated = await this.repository.update(businessId, id, {
        status: exhausted ? DeadLetterStatus.DISCARDED : DeadLetterStatus.PENDING,
        error_message: err instanceof Error ? err.message : String(err),
        ...(exhausted ? { resolved_at: new Date(), resolution: 'auto-discarded after max replays' } : {}),
      });
      this.logger.warn(
        `Replay of dead letter ${id} failed (${attempts} attempts)${exhausted ? ' — discarded' : ''}`,
      );
      return redact(updated);
    }
  }

  /** Mark a dead letter permanently handled by a human (RESOLVED or DISCARDED). */
  async resolve(
    businessId: string,
    id: string,
    status: DeadLetterStatus,
    note?: string,
  ): Promise<RedactedDeadLetter> {
    if (status !== DeadLetterStatus.RESOLVED && status !== DeadLetterStatus.DISCARDED) {
      throw new BadRequestException('resolve status must be RESOLVED or DISCARDED');
    }
    await this.get(businessId, id);
    const updated = await this.repository.update(businessId, id, {
      status,
      resolution: note ?? null,
      resolved_at: new Date(),
    });
    this.eventEmitter.emit(REALTY_HARDENING_EVENTS.DEAD_LETTER_RESOLVED, {
      businessId,
      deadLetterId: id,
      status,
    });
    return redact(updated);
  }

  async stats(businessId: string): Promise<Record<string, number>> {
    const [pending, replayed, resolved, discarded] = await Promise.all([
      this.repository.countByStatus(businessId, DeadLetterStatus.PENDING),
      this.repository.countByStatus(businessId, DeadLetterStatus.REPLAYED),
      this.repository.countByStatus(businessId, DeadLetterStatus.RESOLVED),
      this.repository.countByStatus(businessId, DeadLetterStatus.DISCARDED),
    ]);
    return { pending, replayed, resolved, discarded };
  }

  private readPayload(entry: RedactedDeadLetter): Record<string, unknown> {
    const p = entry.payload;
    return p && typeof p === 'object' && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : {};
  }
}
