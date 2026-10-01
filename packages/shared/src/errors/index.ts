/**
 * The GoSumo error taxonomy.
 *
 * Every deliberate failure in the platform is one of a small number of kinds,
 * and the kind — not the message text — is what callers, the HTTP filter, and
 * the queue retry policy branch on. A bare `throw new Error('...')` carries
 * none of that: it reaches the exception filter indistinguishable from a driver
 * crash, so it surfaces as a 500 with a generic body and gets logged as a
 * server fault even when it was an ordinary "that id isn't yours".
 *
 * Three properties do the work:
 *
 *  - `code` — a stable machine-readable discriminant. Safe to expose; clients
 *    and integration tests may branch on it, so treat it as public API.
 *  - `httpStatus` — a plain number, deliberately not a Nest `HttpStatus`. This
 *    package is framework-free and is imported by workers and scripts that
 *    never load Nest; the API's exception filter is what turns it into a
 *    response.
 *  - `retryable` — whether re-running the identical operation could plausibly
 *    succeed. A 502 from a provider is retryable; a malformed payload is not.
 *    BullMQ consumers use this to decide between a retry and the DLQ.
 *
 * `context` is structured detail for logs and is **never** serialised into an
 * HTTP response. Ids, tenant ids, provider bodies, and SQL fragments go there;
 * `message` stays safe to show a caller.
 */

/** Stable, machine-readable discriminants. Safe to expose to clients. */
export enum ErrorCode {
  /** The addressed resource does not exist within the caller's tenant. */
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  /** The request was well-formed but semantically invalid. */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** No usable credentials were presented, or they have expired. */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** The resource exists but the caller may not act on it. */
  FORBIDDEN = 'FORBIDDEN',
  /** The action conflicts with the resource's current state. */
  CONFLICT = 'CONFLICT',
  /** The caller has exceeded a rate limit or quota. */
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  /** A third-party service failed or answered unusably. */
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  /** Required configuration is missing or unusable at runtime. */
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  /** An inbound provider payload could not be understood. */
  PAYLOAD_PARSE_ERROR = 'PAYLOAD_PARSE_ERROR',
  /** The operation is valid in general but unsupported on this channel/plan. */
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',
  /** An unclassified server fault. The catch-all — never a caller's mistake. */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface GoSumoErrorOptions {
  /** The underlying failure, preserved for the log's stack chain. */
  cause?: unknown;
  /** Structured, log-only detail. Never serialised to a client. */
  context?: Record<string, unknown>;
}

/**
 * Base class for every deliberate GoSumo failure.
 *
 * `message` is written to be safe to hand to a caller — put ids, tenant ids,
 * provider response bodies, and anything else sensitive in `context`.
 */
export abstract class GoSumoError extends Error {
  abstract readonly code: ErrorCode;
  /** Suggested HTTP status. A plain number — this package never imports Nest. */
  abstract readonly httpStatus: number;
  /** Whether re-running the identical operation could plausibly succeed. */
  readonly retryable: boolean = false;
  /** Log-only structured detail. */
  readonly context: Record<string, unknown>;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.context = options.context ?? {};
    if (options.cause !== undefined) {
      // `cause` is ES2022 and in the target lib, but assigning it explicitly
      // keeps the value present when this is transpiled for older runtimes.
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Restores the prototype chain across the ES5 class-extends-Error downlevel,
    // so `instanceof` keeps working for subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** The shape the API's exception filter renders and the logger records. */
  toJSON(): {
    name: string;
    code: ErrorCode;
    httpStatus: number;
    retryable: boolean;
    message: string;
    context: Record<string, unknown>;
  } {
    return {
      name: this.name,
      code: this.code,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * The addressed resource does not exist **within the caller's tenant**.
 *
 * This is deliberately the same error whether the row is absent, soft-deleted,
 * or owned by another business: distinguishing them would confirm to a caller
 * that an id exists somewhere else on the platform. The discriminating detail
 * goes to `context` for the log.
 */
export class ResourceNotFoundError extends GoSumoError {
  readonly code = ErrorCode.RESOURCE_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(
    readonly resource: string,
    readonly resourceId: string,
    options: GoSumoErrorOptions = {},
  ) {
    super(`${resource} not found`, {
      ...options,
      context: { resource, resourceId, ...options.context },
    });
  }
}

/** The request was well-formed but semantically invalid. */
export class ValidationError extends GoSumoError {
  readonly code = ErrorCode.VALIDATION_FAILED;
  readonly httpStatus = 400;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * No usable credentials were presented, or they have expired.
 *
 * Distinct from `ForbiddenActionError`: this says "we do not know who you are",
 * so a caller can react by refreshing a token rather than giving up.
 */
export class UnauthenticatedError extends GoSumoError {
  readonly code = ErrorCode.UNAUTHENTICATED;
  readonly httpStatus = 401;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/** The resource is visible to the caller but this action is not permitted. */
export class ForbiddenActionError extends GoSumoError {
  readonly code = ErrorCode.FORBIDDEN;
  readonly httpStatus = 403;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/** The action conflicts with the resource's current state. */
export class ConflictError extends GoSumoError {
  readonly code = ErrorCode.CONFLICT;
  readonly httpStatus = 409;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * A third-party service failed or answered unusably.
 *
 * `retryable` is derived from the provider's status when one is given, so a
 * queue consumer can tell a transient 503 from a permanent 400 without parsing
 * the message. 408/429 and every 5xx are worth retrying; a 4xx that the
 * provider will answer the same way forever is not. With no status at all
 * (a socket error, a DNS failure) the default is to retry.
 */
export class ExternalServiceError extends GoSumoError {
  readonly code = ErrorCode.EXTERNAL_SERVICE_ERROR;
  readonly httpStatus = 502;
  override readonly retryable: boolean;

  constructor(
    readonly service: string,
    message: string,
    options: GoSumoErrorOptions & { status?: number; retryable?: boolean } = {},
  ) {
    super(message, {
      cause: options.cause,
      context: { service, status: options.status, ...options.context },
    });
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
  }
}

/** Whether a provider HTTP status is worth retrying unchanged. */
export function isRetryableStatus(status?: number): boolean {
  if (status === undefined) return true; // transport-level failure
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Required configuration is missing or unusable.
 *
 * Always a server fault (500), never the caller's: a request that arrives at a
 * service with no API key configured did nothing wrong.
 */
export class ConfigurationError extends GoSumoError {
  readonly code = ErrorCode.CONFIGURATION_ERROR;
  readonly httpStatus = 500;

  constructor(
    readonly configKey: string,
    message: string,
    options: GoSumoErrorOptions = {},
  ) {
    super(message, { ...options, context: { configKey, ...options.context } });
  }
}

/**
 * An inbound provider payload could not be understood.
 *
 * Never retryable — the same bytes will fail to parse forever, so a consumer
 * should DLQ it for inspection rather than burn its attempt budget.
 */
export class PayloadParseError extends GoSumoError {
  readonly code = ErrorCode.PAYLOAD_PARSE_ERROR;
  readonly httpStatus = 400;

  constructor(
    readonly source: string,
    message: string,
    options: GoSumoErrorOptions = {},
  ) {
    super(message, { ...options, context: { source, ...options.context } });
  }
}

/** Valid in general, but unsupported on this channel, plan, or provider. */
export class UnsupportedOperationError extends GoSumoError {
  readonly code = ErrorCode.UNSUPPORTED_OPERATION;
  readonly httpStatus = 422;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * The caller has exceeded a rate limit or plan quota.
 *
 * Retryable by definition — the same request succeeds once the window rolls
 * over. `retryAfterSeconds` goes to `context` for the log and is what a caller
 * should wait before trying again.
 */
export class RateLimitExceededError extends GoSumoError {
  readonly code = ErrorCode.RATE_LIMIT_EXCEEDED;
  readonly httpStatus = 429;
  override readonly retryable = true;

  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    options: GoSumoErrorOptions = {},
  ) {
    super(message, {
      ...options,
      context: { retryAfterSeconds, ...options.context },
    });
  }
}

/**
 * An unclassified server fault.
 *
 * The catch-all the exception filter falls back to. Retryable: a 500 that was
 * not deliberately classified is more often a transient fault than a permanent
 * one, and a caller that already decided to retry should not be talked out of it.
 */
export class InternalError extends GoSumoError {
  readonly code = ErrorCode.INTERNAL_ERROR;
  readonly httpStatus = 500;
  override readonly retryable = true;

  constructor(message: string, options: GoSumoErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * The canonical HTTP-status → `ErrorCode` mapping.
 *
 * Most of the platform still throws framework exceptions (`NotFoundException`
 * and friends), which carry a status but no taxonomy code. This is what lets
 * the API's exception filter put a stable code on *every* response, so clients
 * can branch on one vocabulary regardless of how a failure was raised. Where a
 * throw site does supply a code, that code always wins — this is only the
 * fallback.
 *
 * Statuses that have no dedicated code fall back by class: any other 4xx is the
 * caller's mistake (`VALIDATION_FAILED`), anything else is ours
 * (`INTERNAL_ERROR`).
 */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_FAILED;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.RESOURCE_NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.UNSUPPORTED_OPERATION;
    case 429:
      return ErrorCode.RATE_LIMIT_EXCEEDED;
    case 502:
    case 503:
    case 504:
      return ErrorCode.EXTERNAL_SERVICE_ERROR;
    default:
      return status >= 400 && status < 500
        ? ErrorCode.VALIDATION_FAILED
        : ErrorCode.INTERNAL_ERROR;
  }
}

/** Narrowing helper for `catch (err: unknown)` blocks. */
export function isGoSumoError(err: unknown): err is GoSumoError {
  return err instanceof GoSumoError;
}

/**
 * Whether a failure is worth retrying. Unknown throwables default to retryable
 * — a caller that has already decided to retry on failure should not have that
 * decision reversed by an error it could not classify.
 */
export function isRetryableError(err: unknown): boolean {
  return isGoSumoError(err) ? err.retryable : true;
}

/** Message of any throwable, for log lines. Never assumes an Error instance. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
