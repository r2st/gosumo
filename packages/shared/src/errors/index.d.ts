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
export declare enum ErrorCode {
    /** The addressed resource does not exist within the caller's tenant. */
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND",
    /** The request was well-formed but semantically invalid. */
    VALIDATION_FAILED = "VALIDATION_FAILED",
    /** The resource exists but the caller may not act on it. */
    FORBIDDEN = "FORBIDDEN",
    /** The action conflicts with the resource's current state. */
    CONFLICT = "CONFLICT",
    /** A third-party service failed or answered unusably. */
    EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
    /** Required configuration is missing or unusable at runtime. */
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
    /** An inbound provider payload could not be understood. */
    PAYLOAD_PARSE_ERROR = "PAYLOAD_PARSE_ERROR",
    /** The operation is valid in general but unsupported on this channel/plan. */
    UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
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
export declare abstract class GoSumoError extends Error {
    abstract readonly code: ErrorCode;
    /** Suggested HTTP status. A plain number — this package never imports Nest. */
    abstract readonly httpStatus: number;
    /** Whether re-running the identical operation could plausibly succeed. */
    readonly retryable: boolean;
    /** Log-only structured detail. */
    readonly context: Record<string, unknown>;
    constructor(message: string, options?: GoSumoErrorOptions);
    /** The shape the API's exception filter renders and the logger records. */
    toJSON(): {
        name: string;
        code: ErrorCode;
        httpStatus: number;
        retryable: boolean;
        message: string;
        context: Record<string, unknown>;
    };
}
/**
 * The addressed resource does not exist **within the caller's tenant**.
 *
 * This is deliberately the same error whether the row is absent, soft-deleted,
 * or owned by another business: distinguishing them would confirm to a caller
 * that an id exists somewhere else on the platform. The discriminating detail
 * goes to `context` for the log.
 */
export declare class ResourceNotFoundError extends GoSumoError {
    readonly resource: string;
    readonly resourceId: string;
    readonly code = ErrorCode.RESOURCE_NOT_FOUND;
    readonly httpStatus = 404;
    constructor(resource: string, resourceId: string, options?: GoSumoErrorOptions);
}
/** The request was well-formed but semantically invalid. */
export declare class ValidationError extends GoSumoError {
    readonly code = ErrorCode.VALIDATION_FAILED;
    readonly httpStatus = 400;
    constructor(message: string, options?: GoSumoErrorOptions);
}
/** The resource is visible to the caller but this action is not permitted. */
export declare class ForbiddenActionError extends GoSumoError {
    readonly code = ErrorCode.FORBIDDEN;
    readonly httpStatus = 403;
    constructor(message: string, options?: GoSumoErrorOptions);
}
/** The action conflicts with the resource's current state. */
export declare class ConflictError extends GoSumoError {
    readonly code = ErrorCode.CONFLICT;
    readonly httpStatus = 409;
    constructor(message: string, options?: GoSumoErrorOptions);
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
export declare class ExternalServiceError extends GoSumoError {
    readonly service: string;
    readonly code = ErrorCode.EXTERNAL_SERVICE_ERROR;
    readonly httpStatus = 502;
    readonly retryable: boolean;
    constructor(service: string, message: string, options?: GoSumoErrorOptions & {
        status?: number;
        retryable?: boolean;
    });
}
/** Whether a provider HTTP status is worth retrying unchanged. */
export declare function isRetryableStatus(status?: number): boolean;
/**
 * Required configuration is missing or unusable.
 *
 * Always a server fault (500), never the caller's: a request that arrives at a
 * service with no API key configured did nothing wrong.
 */
export declare class ConfigurationError extends GoSumoError {
    readonly configKey: string;
    readonly code = ErrorCode.CONFIGURATION_ERROR;
    readonly httpStatus = 500;
    constructor(configKey: string, message: string, options?: GoSumoErrorOptions);
}
/**
 * An inbound provider payload could not be understood.
 *
 * Never retryable — the same bytes will fail to parse forever, so a consumer
 * should DLQ it for inspection rather than burn its attempt budget.
 */
export declare class PayloadParseError extends GoSumoError {
    readonly source: string;
    readonly code = ErrorCode.PAYLOAD_PARSE_ERROR;
    readonly httpStatus = 400;
    constructor(source: string, message: string, options?: GoSumoErrorOptions);
}
/** Valid in general, but unsupported on this channel, plan, or provider. */
export declare class UnsupportedOperationError extends GoSumoError {
    readonly code = ErrorCode.UNSUPPORTED_OPERATION;
    readonly httpStatus = 422;
    constructor(message: string, options?: GoSumoErrorOptions);
}
/** Narrowing helper for `catch (err: unknown)` blocks. */
export declare function isGoSumoError(err: unknown): err is GoSumoError;
/**
 * Whether a failure is worth retrying. Unknown throwables default to retryable
 * — a caller that has already decided to retry on failure should not have that
 * decision reversed by an error it could not classify.
 */
export declare function isRetryableError(err: unknown): boolean;
/** Message of any throwable, for log lines. Never assumes an Error instance. */
export declare function errorMessage(err: unknown): string;
//# sourceMappingURL=index.d.ts.map