"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnsupportedOperationError = exports.PayloadParseError = exports.ConfigurationError = exports.ExternalServiceError = exports.ConflictError = exports.ForbiddenActionError = exports.ValidationError = exports.ResourceNotFoundError = exports.GoSumoError = exports.ErrorCode = void 0;
exports.isRetryableStatus = isRetryableStatus;
exports.isGoSumoError = isGoSumoError;
exports.isRetryableError = isRetryableError;
exports.errorMessage = errorMessage;
/** Stable, machine-readable discriminants. Safe to expose to clients. */
var ErrorCode;
(function (ErrorCode) {
    /** The addressed resource does not exist within the caller's tenant. */
    ErrorCode["RESOURCE_NOT_FOUND"] = "RESOURCE_NOT_FOUND";
    /** The request was well-formed but semantically invalid. */
    ErrorCode["VALIDATION_FAILED"] = "VALIDATION_FAILED";
    /** The resource exists but the caller may not act on it. */
    ErrorCode["FORBIDDEN"] = "FORBIDDEN";
    /** The action conflicts with the resource's current state. */
    ErrorCode["CONFLICT"] = "CONFLICT";
    /** A third-party service failed or answered unusably. */
    ErrorCode["EXTERNAL_SERVICE_ERROR"] = "EXTERNAL_SERVICE_ERROR";
    /** Required configuration is missing or unusable at runtime. */
    ErrorCode["CONFIGURATION_ERROR"] = "CONFIGURATION_ERROR";
    /** An inbound provider payload could not be understood. */
    ErrorCode["PAYLOAD_PARSE_ERROR"] = "PAYLOAD_PARSE_ERROR";
    /** The operation is valid in general but unsupported on this channel/plan. */
    ErrorCode["UNSUPPORTED_OPERATION"] = "UNSUPPORTED_OPERATION";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
/**
 * Base class for every deliberate GoSumo failure.
 *
 * `message` is written to be safe to hand to a caller — put ids, tenant ids,
 * provider response bodies, and anything else sensitive in `context`.
 */
class GoSumoError extends Error {
    /** Whether re-running the identical operation could plausibly succeed. */
    retryable = false;
    /** Log-only structured detail. */
    context;
    constructor(message, options = {}) {
        super(message);
        this.name = new.target.name;
        this.context = options.context ?? {};
        if (options.cause !== undefined) {
            // `cause` is ES2022 and in the target lib, but assigning it explicitly
            // keeps the value present when this is transpiled for older runtimes.
            this.cause = options.cause;
        }
        // Restores the prototype chain across the ES5 class-extends-Error downlevel,
        // so `instanceof` keeps working for subclasses.
        Object.setPrototypeOf(this, new.target.prototype);
    }
    /** The shape the API's exception filter renders and the logger records. */
    toJSON() {
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
exports.GoSumoError = GoSumoError;
/**
 * The addressed resource does not exist **within the caller's tenant**.
 *
 * This is deliberately the same error whether the row is absent, soft-deleted,
 * or owned by another business: distinguishing them would confirm to a caller
 * that an id exists somewhere else on the platform. The discriminating detail
 * goes to `context` for the log.
 */
class ResourceNotFoundError extends GoSumoError {
    resource;
    resourceId;
    code = ErrorCode.RESOURCE_NOT_FOUND;
    httpStatus = 404;
    constructor(resource, resourceId, options = {}) {
        super(`${resource} not found`, {
            ...options,
            context: { resource, resourceId, ...options.context },
        });
        this.resource = resource;
        this.resourceId = resourceId;
    }
}
exports.ResourceNotFoundError = ResourceNotFoundError;
/** The request was well-formed but semantically invalid. */
class ValidationError extends GoSumoError {
    code = ErrorCode.VALIDATION_FAILED;
    httpStatus = 400;
    constructor(message, options = {}) {
        super(message, options);
    }
}
exports.ValidationError = ValidationError;
/** The resource is visible to the caller but this action is not permitted. */
class ForbiddenActionError extends GoSumoError {
    code = ErrorCode.FORBIDDEN;
    httpStatus = 403;
    constructor(message, options = {}) {
        super(message, options);
    }
}
exports.ForbiddenActionError = ForbiddenActionError;
/** The action conflicts with the resource's current state. */
class ConflictError extends GoSumoError {
    code = ErrorCode.CONFLICT;
    httpStatus = 409;
    constructor(message, options = {}) {
        super(message, options);
    }
}
exports.ConflictError = ConflictError;
/**
 * A third-party service failed or answered unusably.
 *
 * `retryable` is derived from the provider's status when one is given, so a
 * queue consumer can tell a transient 503 from a permanent 400 without parsing
 * the message. 408/429 and every 5xx are worth retrying; a 4xx that the
 * provider will answer the same way forever is not. With no status at all
 * (a socket error, a DNS failure) the default is to retry.
 */
class ExternalServiceError extends GoSumoError {
    service;
    code = ErrorCode.EXTERNAL_SERVICE_ERROR;
    httpStatus = 502;
    retryable;
    constructor(service, message, options = {}) {
        super(`${service}: ${message}`, {
            cause: options.cause,
            context: { service, status: options.status, ...options.context },
        });
        this.service = service;
        this.retryable = options.retryable ?? isRetryableStatus(options.status);
    }
}
exports.ExternalServiceError = ExternalServiceError;
/** Whether a provider HTTP status is worth retrying unchanged. */
function isRetryableStatus(status) {
    if (status === undefined)
        return true; // transport-level failure
    if (status === 408 || status === 429)
        return true;
    return status >= 500;
}
/**
 * Required configuration is missing or unusable.
 *
 * Always a server fault (500), never the caller's: a request that arrives at a
 * service with no API key configured did nothing wrong.
 */
class ConfigurationError extends GoSumoError {
    configKey;
    code = ErrorCode.CONFIGURATION_ERROR;
    httpStatus = 500;
    constructor(configKey, message, options = {}) {
        super(message, { ...options, context: { configKey, ...options.context } });
        this.configKey = configKey;
    }
}
exports.ConfigurationError = ConfigurationError;
/**
 * An inbound provider payload could not be understood.
 *
 * Never retryable — the same bytes will fail to parse forever, so a consumer
 * should DLQ it for inspection rather than burn its attempt budget.
 */
class PayloadParseError extends GoSumoError {
    source;
    code = ErrorCode.PAYLOAD_PARSE_ERROR;
    httpStatus = 400;
    constructor(source, message, options = {}) {
        super(message, { ...options, context: { source, ...options.context } });
        this.source = source;
    }
}
exports.PayloadParseError = PayloadParseError;
/** Valid in general, but unsupported on this channel, plan, or provider. */
class UnsupportedOperationError extends GoSumoError {
    code = ErrorCode.UNSUPPORTED_OPERATION;
    httpStatus = 422;
    constructor(message, options = {}) {
        super(message, options);
    }
}
exports.UnsupportedOperationError = UnsupportedOperationError;
/** Narrowing helper for `catch (err: unknown)` blocks. */
function isGoSumoError(err) {
    return err instanceof GoSumoError;
}
/**
 * Whether a failure is worth retrying. Unknown throwables default to retryable
 * — a caller that has already decided to retry on failure should not have that
 * decision reversed by an error it could not classify.
 */
function isRetryableError(err) {
    return isGoSumoError(err) ? err.retryable : true;
}
/** Message of any throwable, for log lines. Never assumes an Error instance. */
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
//# sourceMappingURL=index.js.map