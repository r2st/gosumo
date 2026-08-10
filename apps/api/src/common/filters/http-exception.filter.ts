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

export interface ApiError {
  statusCode: number;
  error: string;
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

    const traceId =
      (request.headers['x-correlation-id'] as string | undefined) ?? uuidv4();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.message;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp['message'] as string | string[] | undefined) ?? exception.message;
        error = (resp['error'] as string | undefined) ?? exception.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];
      if (mapped) {
        statusCode = mapped.status;
        message = mapped.message;
        error = HttpStatus[mapped.status] ?? 'Error';
      }
      // Unmapped Prisma codes fall through as a 500 with the generic message
      // below — the driver's own text can carry table and column names.
    } else if (exception instanceof Error) {
      // Deliberately NOT surfacing `exception.message` here. Unhandled errors
      // routinely embed connection strings, SQL fragments, and file paths;
      // the detail goes to the log (with the traceId) instead of the client.
      error = 'Internal Server Error';
    }

    const errorResponse: ApiError = {
      statusCode,
      error,
      message,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${traceId}] ${request.method} ${request.url} → ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${traceId}] ${request.method} ${request.url} → ${statusCode}: ${JSON.stringify(message)}`,
      );
    }

    response.status(statusCode).json(errorResponse);
  }
}
