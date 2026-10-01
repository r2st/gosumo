import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { assertChannelEncryptionKey } from './common/utils/encryption.util';
import {
  allowCredentials,
  resolveCorsOrigin as parseCorsOrigin,
} from './common/utils/cors.util';
import { correlationId } from './common/middleware/correlation-id.middleware';
import { API_VERSION } from './common/versioning/api-version.constants';
import { securityHeaders } from './common/middleware/security-headers.middleware';
import {
  bodyShapeGuard,
  MAX_BODY_DEPTH,
} from './common/middleware/body-shape-guard.middleware';

/** True when this process is running as production. */
export function isProduction(): boolean {
  return (process.env['NODE_ENV'] ?? 'development') === 'production';
}

/**
 * Parse `CORS_ORIGIN` into the allow-list. A comma-separated value becomes a
 * list; anything else is passed through, so an unset var still means `*`.
 */
export function resolveCorsOrigin(raw = process.env['CORS_ORIGIN'] ?? '*'): string | string[] {
  return parseCorsOrigin(raw);
}

export { allowCredentials };

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
 * The last error boundary in the process.
 *
 * Nothing was listening for either of these. That is not the same as "neither
 * happens": it is the difference between a diagnosable failure and a process
 * that vanishes.
 *
 *  - **`unhandledRejection`** — Node 15+ defaults to `--unhandled-rejections=throw`,
 *    so one floating promise anywhere in the app kills the whole API. Most of
 *    them are side paths that the request or job did not await on purpose
 *    (fire-and-forget audit writes, cache refreshes, telemetry), and taking a
 *    multi-tenant API down for one is the wrong trade — it turns a lost log
 *    line into an outage. Logged loudly and survived, which is also the only
 *    way anyone finds out the promise existed.
 *
 *  - **`uncaughtException`** — the opposite call. The stack that threw is gone
 *    and whatever it was halfway through stays halfway through, so continuing
 *    means running on state no one can reason about. Log it (Node's own
 *    printout is what installing a handler suppresses, so this has to replace
 *    it) and exit non-zero, which is what tells the supervisor to restart.
 *
 * Registered with `process.on` and guarded by {@link safetyNetsInstalled} so a
 * second call — a test importing this module twice, a nested bootstrap — does
 * not stack duplicate handlers and log everything twice.
 */
let safetyNetsInstalled = false;

/** Exit code used when an uncaught exception ends the process. */
export const UNCAUGHT_EXCEPTION_EXIT_CODE = 1;

/** Reset the install guard. Tests only — a fresh process installs once. */
export function resetProcessSafetyNets(): void {
  safetyNetsInstalled = false;
}

export function installProcessSafetyNets(
  logger: Logger,
  onFatal: (code: number) => void = (code) => process.exit(code),
  target: NodeJS.EventEmitter = process,
): boolean {
  if (safetyNetsInstalled) return false;
  safetyNetsInstalled = true;

  target.on('unhandledRejection', (reason: unknown) => {
    const detail =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
    logger.error(
      `Unhandled promise rejection — the process is being kept alive, but this is a bug: ${detail}`,
    );
  });

  target.on('uncaughtException', (err: unknown) => {
    const detail =
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    logger.error(`Uncaught exception — shutting down: ${detail}`);
    onFatal(UNCAUGHT_EXCEPTION_EXIT_CODE);
  });

  return true;
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

/**
 * Largest request body the API will read, for every content type.
 *
 * Until this was set the limit was body-parser's default of 100 KB — a bound
 * nobody chose, and one the API's own contract already exceeded:
 * `CsvImportDto` advertises `@ArrayMaxSize(5000)` rows, and 5000 lead rows is
 * roughly 400 KB of JSON, so a full-size import was refused with a bare 413
 * from the parser rather than by anything that could explain itself. The
 * documented ceiling was unreachable and the real one was invisible.
 *
 * 1 MB is set deliberately above every DTO's own declared maximum and far
 * below what a body this process should buffer: nothing here receives file
 * bytes (media is uploaded out of band and only its metadata is posted), so no
 * legitimate request is anywhere near it. The per-DTO caps — `ArrayMaxSize`,
 * `MaxLength` — remain the bound on *work*; this is the bound on *bytes*, which
 * is charged before any of them get to run.
 *
 * Applied after {@link securityHeaders} so that a 413 from the parser, which
 * never reaches a controller or the global exception filter, still carries
 * them. Express's own final handler answers it, and omits the stack when
 * `NODE_ENV=production`.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** The `useBodyParser` surface this file needs — kept narrow so it is mockable. */
export interface BodyParserConfigurableApp {
  useBodyParser(
    parser: 'json' | 'urlencoded' | 'text' | 'raw',
    options?: Record<string, unknown>,
  ): unknown;
}

/**
 * Most form fields accepted in a single urlencoded body.
 *
 * body-parser's default is 1,000, which is fine; it is named here because the
 * `extended: true` parser underneath is `qs`, and `qs` will happily build a
 * deeply nested object out of bracket syntax — `a[b][c][d]…` — long before the
 * byte cap is reached. `depth` is the bound on that, and it is the urlencoded
 * counterpart to what {@link bodyShapeGuard} does for JSON. Set to the same
 * value so a body is not accepted on one content type and rejected on the
 * other.
 */
export const MAX_URLENCODED_PARAMETERS = 1_000;

/**
 * Install the JSON and urlencoded parsers at {@link MAX_REQUEST_BODY_BYTES}.
 *
 * `extended: true` mirrors what Nest's own registration passes, so the only
 * difference from the default setup is the ceiling and the two `qs` bounds
 * above.
 */
export function applyBodyLimits(
  app: BodyParserConfigurableApp,
  limit: number = MAX_REQUEST_BODY_BYTES,
): void {
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', {
    limit,
    extended: true,
    parameterLimit: MAX_URLENCODED_PARAMETERS,
    depth: MAX_BODY_DEPTH,
  });
}

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

  // Before anything that could throw asynchronously — including the startup
  // checks below, which are the first code in the process that can.
  installProcessSafetyNets(logger);

  runStartupChecks(logger);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  // Global prefix — the API's one and only version, applied here and nowhere
  // else. Controllers declare their paths without it; see API_VERSION.
  app.setGlobalPrefix(API_VERSION);

  // Security headers, before anything else so a response that never reaches a
  // controller — a 401 from the global guard, a 404 — still carries them.
  // HSTS only in production: TLS terminates at Caddy there, whereas sending it
  // over plain http in development pins the browser to an https port that does
  // not exist, and the fix for that is clearing browser state.
  // First in the chain, so everything after it — including a 401 from the
  // global guard and a 413 from the body parser, neither of which reaches a
  // controller — is logged under an id and answers with one.
  app.use(correlationId());

  app.use(securityHeaders({ hsts: isProduction() }));
  // Express's default advertisement of what is running here. Free to remove.
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');

  // Body size ceiling, registered here rather than left to body-parser's 100 KB
  // default (see MAX_REQUEST_BODY_BYTES). Registering a parser now claims the
  // slot: Nest's own `registerParserMiddleware` runs at init and skips a parser
  // that is already applied, so these are the only ones installed — and they
  // inherit `rawBody: true` from the factory options, which the webhook HMAC
  // checks depend on.
  applyBodyLimits(app);

  // Shape ceiling, after the parsers (there has to be a parsed body to look
  // at) and before the router. The byte cap above does not bound nesting or
  // key count, and both are cheap enough to express inside 1 MB to overflow
  // the stack of whatever walks the body next — see the middleware's own note.
  app.use(bodyShapeGuard());

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
      .setTitle('DoAide Inbox API')
      .setDescription('AI-powered client management platform API — a DoAide product')
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
    SwaggerModule.setup(`${API_VERSION}/docs`, app, document, {
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
    logger.log(`Swagger docs available at http://localhost:${port}/${API_VERSION}/docs`);
  }
  logger.log(`Environment: ${process.env['NODE_ENV'] ?? 'development'}`);
}

bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start application', err);
  process.exit(1);
});
