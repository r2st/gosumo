import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { assertChannelEncryptionKey } from './common/utils/encryption.util';

/** True when this process is running as production. */
export function isProduction(): boolean {
  return (process.env['NODE_ENV'] ?? 'development') === 'production';
}

/**
 * Parse `CORS_ORIGIN` into the allow-list. A comma-separated value becomes a
 * list; anything else is passed through, so an unset var still means `*`.
 */
export function resolveCorsOrigin(raw = process.env['CORS_ORIGIN'] ?? '*'): string | string[] {
  return raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
}

/**
 * Whether credentialed cross-origin requests may be allowed.
 *
 * `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true` is the one combination the CORS
 * spec forbids outright — and advertising it invites any origin to try. The
 * wildcard is only ever a local-development convenience, so when it is in
 * effect credentials come off rather than the origin being narrowed, which
 * keeps a deployment that has not set `CORS_ORIGIN` working exactly as it did.
 */
export function allowCredentials(origin: string | string[]): boolean {
  return origin !== '*';
}

/**
 * Swagger publishes every route, DTO and example the API has. That is the
 * point in development and a free reconnaissance map in production, where the
 * dashboard does not use it.
 */
export function swaggerEnabled(): boolean {
  return !isProduction() || process.env['ENABLE_SWAGGER'] === 'true';
}

/**
 * Startup checks that must run before anything is served.
 *
 * Reported here rather than at the point of use, because the settings involved
 * fail silently by construction: the thing they protect keeps working, just not
 * in the way the operator believes. A boot-time line is the only moment anyone
 * is looking.
 */
export function runStartupChecks(logger: Logger): void {
  const keyCheck = assertChannelEncryptionKey();
  if (keyCheck.severity === 'fatal') {
    // Refusing to start is the point. Coming up and writing credentials under
    // a key from the public source tree produces a database that looks
    // encrypted and is not — and every row written before anyone notices has
    // to be re-keyed by hand.
    logger.error(keyCheck.message);
    throw new Error(keyCheck.message ?? 'Channel encryption key is not configured');
  }
  if (keyCheck.severity === 'warn') {
    logger.warn(keyCheck.message);
  }
}

/**
 * Keep-alive idle timeout, in ms.
 *
 * Node's default is 5 seconds. Caddy holds its upstream connections open far
 * longer than that, so the API is the side that hangs up — and when it does so
 * in the window where Caddy has just picked that socket to send the next
 * request on, the request dies on a closed connection and the visitor gets a
 * 502 from a healthy backend. The fix is the standard one: outlive the proxy's
 * idle timeout and let *it* do the closing.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Must exceed {@link KEEP_ALIVE_TIMEOUT_MS}. If headers time out first, Node
 * closes sockets it should have kept, which is the same 502 by another route.
 */
export const HEADERS_TIMEOUT_MS = 70_000;

/** The bits of `http.Server` this file touches — kept narrow so it is mockable. */
export interface LifecycleHttpServer {
  keepAliveTimeout?: number;
  headersTimeout?: number;
  closeIdleConnections?: () => void;
}

/** Signals that mean "shut down cleanly" — the same two Nest listens on. */
export const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Give the HTTP server the timeouts and the shutdown behaviour a process
 * behind a reverse proxy needs.
 *
 * The shutdown half is the one that matters. `enableShutdownHooks()` gets Nest
 * to run `app.close()` on SIGTERM, which calls `server.close()` — and
 * `server.close()` stops accepting *new* connections but then waits for every
 * existing one to go away on its own. Caddy's are keep-alive and idle, not
 * gone, so nothing resolves. Shutdown stalls until the supervisor's timer runs
 * out and SIGKILLs the process, which is exactly the ungraceful exit
 * `enableShutdownHooks()` was added to prevent: Prisma's pool is dropped
 * without being returned (against a 50-connection ceiling shared with another
 * service) and BullMQ workers die mid-job.
 *
 * `closeIdleConnections()` — Node 18+ — closes the sockets that have no
 * request in flight, which is what unblocks `server.close()`. Requests already
 * being served are untouched and still get to finish; that is the drain.
 *
 * Registered *after* `enableShutdownHooks()` so Nest's handler runs first: it
 * starts `app.close()` (which stops the listener), and this then clears the
 * idle sockets that would otherwise hold it open.
 */
export function configureHttpServerLifecycle(
  server: LifecycleHttpServer | undefined,
  logger: Logger,
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void = (signal, handler) => {
    process.once(signal, handler);
  },
): void {
  if (!server) {
    logger.warn('No HTTP server available — keep-alive and drain tuning skipped');
    return;
  }

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  for (const signal of SHUTDOWN_SIGNALS) {
    onSignal(signal, () => {
      try {
        // Absent on a server this Node cannot provide it on. Nothing to do
        // then — the wait is the old behaviour, not a new failure.
        server.closeIdleConnections?.();
        logger.log(`${signal} received — idle keep-alive connections closed, draining in-flight`);
      } catch (err) {
        logger.warn(
          `Could not close idle connections on ${signal}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  runStartupChecks(logger);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  // Global prefix
  app.setGlobalPrefix('v1');

  // CORS
  const corsOrigin = resolveCorsOrigin();
  if (corsOrigin === '*' && isProduction()) {
    logger.warn(
      'CORS_ORIGIN is unset in production: falling back to "*" with credentials disabled. ' +
        'Set CORS_ORIGIN to the dashboard origin.',
    );
  }
  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-correlation-id'],
    credentials: allowCredentials(corsOrigin),
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Swagger — development only unless explicitly re-enabled.
  if (swaggerEnabled()) {
    const config = new DocumentBuilder()
      .setTitle('GoSumo API')
      .setDescription('AI-powered client management platform API')
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addTag('auth', 'Authentication endpoints')
      .addTag('tenant', 'Tenant management')
      .addTag('conversation', 'Conversation management')
      .addTag('message', 'Message handling')
      .addTag('ai-engine', 'AI processing')
      .addTag('catalog', 'Product catalog')
      .addTag('booking', 'Booking management')
      .addTag('payment', 'Payment processing')
      .addTag('order', 'Order management')
      .addTag('campaign', 'Marketing campaigns')
      .addTag('analytics', 'Analytics and reporting')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('v1/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  // Graceful shutdown. Without this, Nest never runs onModuleDestroy on a
  // signal, so a systemd restart kills the process with Prisma still holding
  // its pool and BullMQ workers mid-job. Postgres only reaps those connections
  // on its own timeout, and this deployment shares a 50-connection ceiling —
  // a few restarts in a row were enough to exhaust it.
  app.enableShutdownHooks();

  // After enableShutdownHooks, so Nest's handler runs first and this clears
  // the idle sockets that would otherwise keep `server.close()` waiting.
  configureHttpServerLifecycle(
    app.getHttpServer() as LifecycleHttpServer | undefined,
    logger,
  );

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen(port);

  logger.log(`Application running on port ${port}`);
  if (swaggerEnabled()) {
    logger.log(`Swagger docs available at http://localhost:${port}/v1/docs`);
  }
  logger.log(`Environment: ${process.env['NODE_ENV'] ?? 'development'}`);
}

bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start application', err);
  process.exit(1);
});
