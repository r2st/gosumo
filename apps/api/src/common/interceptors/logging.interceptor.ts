import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
} from '../context/correlation-id.util';
import { getCorrelationId } from '../context/request-context';

/**
 * The request/response access log.
 *
 * It no longer mints the correlation id — `correlationId()` middleware does,
 * before the guards run, so that a 401 is logged under the same id as the
 * request that earned it. This reads that id back out of the async context and
 * only falls back to the header (or, failing that, to minting one) for the
 * cases where the middleware is not in the stack: a Nest test harness that
 * builds the interceptor directly, or a future non-HTTP adapter.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const correlationId =
      getCorrelationId() ?? resolveCorrelationId(request.headers?.[CORRELATION_ID_HEADER]);

    // Kept for the fallback path only. When the middleware ran, both of these
    // are already set to this exact value and re-setting them is a no-op.
    if (request.headers) request.headers[CORRELATION_ID_HEADER] = correlationId;
    response.setHeader?.(CORRELATION_ID_HEADER, correlationId);

    const { method, url } = request;
    const userAgent = request.headers?.['user-agent'] ?? '-';
    const startTime = Date.now();

    this.logger.log(`[${correlationId}] → ${method} ${url} | UA: ${userAgent}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const statusCode = response.statusCode;
          this.logger.log(
            `[${correlationId}] ← ${method} ${url} | ${statusCode} | ${duration}ms`,
          );
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          const statusCode = (err as { status?: number })?.status ?? 500;
          /**
           * Debug, not warn.
           *
           * Every failing request already produces a fully-formed line from
           * `HttpExceptionFilter` — with the same correlation id, the same
           * status, and the message — so this one is a duplicate. Emitting it
           * at `warn` meant a 404 on a mistyped URL and a 401 from an expired
           * token, the two highest-volume responses any API serves, each wrote
           * a warning. That is what trains an on-call to stop reading warnings,
           * and it is why a real one gets missed.
           *
           * The line is kept rather than deleted because it is the only one
           * that carries the *duration* of a failed request, which is what
           * distinguishes a rejected request from a slow one that then failed.
           */
          this.logger.debug(
            `[${correlationId}] ← ${method} ${url} | ${statusCode} | ${duration}ms | ERROR`,
          );
        },
      }),
    );
  }
}
