import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GoSumoError, ErrorCode, errorCodeForStatus } from '@gosumo/shared';
import { CORRELATION_ID_HEADER } from '../context/correlation-id.util';
import { getCorrelationId, getRequestContext } from '../context/request-context';
import { redactObject } from '../utils/log-redact.util';

/**
 * Prisma error codes that correspond to a client mistake rather than a server
 * fault. Anything not listed here stays a 500.
 *
 * P2025 matters for tenant isolation: repository writes are scoped with
 * `where: { id, business_id }`, so a cross-tenant or already-deleted id
 * produces P2025. That is a "not found" for the caller — never a 500, and
 * never a signal that the row exists under another tenant.
 */
const PRISMA_ERROR_MAP: Record<string, { status: HttpStatus; message: string }> = {
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Resource not found' },
  P2002: { status: HttpStatus.CONFLICT, message: 'A record with these values already exists' },
  P2003: { status: HttpStatus.BAD_REQUEST, message: 'Referenced record does not exist' },
  P2000: { status: HttpStatus.BAD_REQUEST, message: 'Provided value is too long for the field' },
};

/** The set of valid `ErrorCode` values, for narrowing untrusted strings. */
const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/** Narrows a handler-supplied `error` field to a taxonomy code, or undefined. */
function asErrorCode(value: unknown): ErrorCode | undefined {
  return typeof value === 'string' && ERROR_CODES.has(value)
    ? (value as ErrorCode)
    : undefined;
}

export interface ApiError {
  statusCode: number;
  /**
   * A stable `ErrorCode` — always, whatever raised the failure. Typed errors
   * supply their own; everything else is classified from the status via
   * `errorCodeForStatus`. Clients may branch on this, so it is public API.
   */
  error: ErrorCode;
  message: string | string[];
  traceId: string;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    /**
     * The same id the access log and every line in between used.
     *
     * Read from the async context first: the header fallback works only
     * because `correlationId()` middleware writes the resolved id back onto
     * the request, and a failure that happens before any middleware ran (or in
     * a test harness that mounts the filter alone) has neither. Minting one
     * here is the last resort — it is returned to the caller, so it must never
     * be absent, but an id invented at the end of a request joins nothing,
     * which is why it is third rather than first.
     */
    const traceId =
      getCorrelationId() ??
      (request.headers?.[CORRELATION_ID_HEADER] as string | undefined) ??
      uuidv4();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    /**
     * Set only when the throw site named its own code. Left undefined
     * otherwise, so the status-derived code is used instead — that way every
     * response carries one vocabulary regardless of how it was raised.
     */
    let code: ErrorCode | undefined;
    let message: string | string[] = 'An unexpected error occurred';
    /** Log-only detail from a typed error; never merged into the response. */
    let context: Record<string, unknown> | undefined;

    if (exception instanceof GoSumoError) {
      // Typed errors are authored by us, so both the code and the message are
      // deliberately safe to return. Everything sensitive lives in `context`,
      // which goes to the log line below and never into the body.
      statusCode = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      context = exception.context;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp['message'] as string | string[] | undefined) ?? exception.message;
        // A handler may name a taxonomy code explicitly by throwing
        // `new BadRequestException({ message, error: ErrorCode.X })`. Anything
        // else in `error` is Nest's own prose ("Bad Request") — drop it and
        // classify from the status instead.
        code = asErrorCode(resp['error']);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];
      if (mapped) {
        statusCode = mapped.status;
        message = mapped.message;
      }
      // Unmapped Prisma codes fall through as a 500 with the generic message
      // below — the driver's own text can carry table and column names.
    }
    // Any other throwable stays a 500 with the generic message. Deliberately
    // NOT surfacing `exception.message`: unhandled errors routinely embed
    // connection strings, SQL fragments, and file paths. The detail goes to
    // the log (with the traceId) instead of the client.

    const error = code ?? errorCodeForStatus(statusCode);

    const errorResponse: ApiError = {
      statusCode,
      error,
      message,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    const detail = context && Object.keys(context).length > 0
      ? ` ${JSON.stringify(redactObject(context))}`
      : '';

    const reqCtx = getRequestContext();
    const tenant = reqCtx?.businessId ? ` biz=${reqCtx.businessId}` : '';

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${traceId}]${tenant} ${request.method} ${request.url} → ${statusCode}${detail}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${traceId}]${tenant} ${request.method} ${request.url} → ${statusCode}: ${JSON.stringify(message)}${detail}`,
      );
    }

    response.status(statusCode).json(errorResponse);
  }
}
