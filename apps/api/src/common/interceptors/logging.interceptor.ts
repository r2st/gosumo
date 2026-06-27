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
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Assign or propagate a correlation ID for the entire request lifecycle
    const correlationId =
      (request.headers['x-correlation-id'] as string | undefined) ?? uuidv4();

    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);

    const { method, url } = request;
    const userAgent = request.headers['user-agent'] ?? '-';
    const startTime = Date.now();

    this.logger.log(
      `[${correlationId}] → ${method} ${url} | UA: ${userAgent}`,
    );

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
          const statusCode =
            (err as { status?: number })?.status ?? 500;
          this.logger.warn(
            `[${correlationId}] ← ${method} ${url} | ${statusCode} | ${duration}ms | ERROR`,
          );
        },
      }),
    );
  }
}
