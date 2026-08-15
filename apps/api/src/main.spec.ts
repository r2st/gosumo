/**
 * Bootstrap test for main.ts.
 *
 * Regression coverage for webhook HMAC verification: NestJS only populates
 * `req.rawBody` when the app is created with `{ rawBody: true }`. Without it,
 * signature validation on every inbound webhook fails because the raw payload
 * is undefined. This test pins that option so it cannot silently regress.
 */

// Replace the real DI graph with lightweight stand-ins so importing main.ts
// boots instantly without a database / Redis / module graph.
jest.mock('@nestjs/core', () => {
  const app = {
    setGlobalPrefix: jest.fn(),
    enableCors: jest.fn(),
    use: jest.fn(),
    useBodyParser: jest.fn(),
    getHttpAdapter: jest.fn().mockReturnValue({
      getInstance: jest.fn().mockReturnValue({ disable: jest.fn() }),
    }),
    useGlobalPipes: jest.fn(),
    useGlobalFilters: jest.fn(),
    useGlobalInterceptors: jest.fn(),
    enableShutdownHooks: jest.fn(),
    getHttpServer: jest.fn().mockReturnValue({ closeIdleConnections: jest.fn() }),
    listen: jest.fn().mockResolvedValue(undefined),
  };
  return { NestFactory: { create: jest.fn().mockResolvedValue(app) } };
});

jest.mock('@nestjs/swagger', () => ({
  SwaggerModule: {
    createDocument: jest.fn().mockReturnValue({}),
    setup: jest.fn(),
  },
  DocumentBuilder: jest.fn().mockImplementation(() => ({
    setTitle: jest.fn().mockReturnThis(),
    setDescription: jest.fn().mockReturnThis(),
    setVersion: jest.fn().mockReturnThis(),
    addBearerAuth: jest.fn().mockReturnThis(),
    addTag: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
}));

jest.mock('./app.module', () => ({ AppModule: class {} }));
jest.mock('./common/filters/http-exception.filter', () => ({
  HttpExceptionFilter: class {},
}));
jest.mock('./common/interceptors/logging.interceptor', () => ({
  LoggingInterceptor: class {},
}));

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_REQUEST_BODY_BYTES,
  SHUTDOWN_SIGNALS,
  UNCAUGHT_EXCEPTION_EXIT_CODE,
  allowCredentials,
  applyBodyLimits,
  MAX_URLENCODED_PARAMETERS,
  configureHttpServerLifecycle,
  installProcessSafetyNets,
  isProduction,
  resetProcessSafetyNets,
  resolveCorsOrigin,
  runStartupChecks,
  swaggerEnabled,
} from './main';
import { MAX_BODY_DEPTH } from './common/middleware/body-shape-guard.middleware';

describe('bootstrap (main.ts)', () => {
  it('creates the Nest app with rawBody enabled for webhook HMAC validation', async () => {
    await import('./main');
    // Flush microtasks so the async bootstrap() reaches NestFactory.create.
    await new Promise((resolve) => setImmediate(resolve));

    expect(NestFactory.create).toHaveBeenCalledWith(
      AppModule,
      expect.objectContaining({ rawBody: true }),
    );
  });

  it('installs the security headers as middleware, not as an interceptor', async () => {
    // Middleware runs before the global JwtAuthGuard; an interceptor runs
    // after it. Getting this wrong sends every 401 — one of the most-served
    // responses here — with no nosniff and no CSP.
    await import('./main');
    await new Promise((resolve) => setImmediate(resolve));

    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;
    expect(app.use).toHaveBeenCalledWith(expect.any(Function));
    expect(app.getHttpAdapter().getInstance().disable).toHaveBeenCalledWith('x-powered-by');
  });

  it('enables shutdown hooks before it starts listening', async () => {
    // Without these, Nest never runs onModuleDestroy on a signal: a systemd
    // restart kills the process with Prisma still holding its pool and BullMQ
    // workers mid-job. Postgres only reaps those on its own timeout, and this
    // deployment shares a 50-connection ceiling.
    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;

    expect(app.enableShutdownHooks).toHaveBeenCalled();
    expect(app.listen).toHaveBeenCalled();
  });

  it('bounds the request body instead of inheriting body-parser default', async () => {
    // 100 KB was never chosen — and CsvImportDto advertises 5000 rows, which
    // is roughly 400 KB of JSON, so the API's own documented ceiling was
    // unreachable behind a bare 413 from the parser.
    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;

    expect(app.useBodyParser).toHaveBeenCalledWith(
      'json',
      expect.objectContaining({ limit: MAX_REQUEST_BODY_BYTES }),
    );
    expect(app.useBodyParser).toHaveBeenCalledWith(
      'urlencoded',
      expect.objectContaining({ limit: MAX_REQUEST_BODY_BYTES }),
    );
  });

  it('installs the body parsers after the security headers', async () => {
    // A 413 from body-parser never reaches a controller or the global
    // exception filter — Express's own final handler answers it. Registering
    // the parsers after the header middleware is what keeps nosniff and the
    // CSP on that response; swapping the order strips them.
    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;

    const headersAt = (app.use as jest.Mock).mock.invocationCallOrder[0];
    const parserAt = (app.useBodyParser as jest.Mock).mock.invocationCallOrder[0];
    expect(headersAt).toBeLessThan(parserAt!);
  });

  it('installs the body shape guard after the parsers, not before', async () => {
    // It inspects `req.body`, so registering it ahead of the parsers gives it
    // `undefined` on every request — a guard that passes everything and looks
    // installed. Ordering is the only thing that makes it do anything.
    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;

    const parserAt = (app.useBodyParser as jest.Mock).mock.invocationCallOrder[0];
    const useOrder = (app.use as jest.Mock).mock.invocationCallOrder;
    const guardAt = useOrder[useOrder.length - 1];

    expect(guardAt).toBeGreaterThan(parserAt!);
  });

  describe('applyBodyLimits', () => {
    it('passes extended: true to urlencoded, matching Nest own registration', () => {
      // The only intended difference from the default setup is the ceiling —
      // dropping `extended` would quietly change how nested keys parse.
      const app = { useBodyParser: jest.fn() };
      applyBodyLimits(app);

      expect(app.useBodyParser).toHaveBeenCalledWith('urlencoded', {
        limit: MAX_REQUEST_BODY_BYTES,
        extended: true,
        parameterLimit: MAX_URLENCODED_PARAMETERS,
        depth: MAX_BODY_DEPTH,
      });
    });

    it('bounds qs nesting on the urlencoded parser too', () => {
      // `extended: true` is `qs`, which builds nested objects out of bracket
      // syntax — `a[b][c][d]…` reaches arbitrary depth in a few hundred bytes,
      // well inside the byte cap. Without `depth` the JSON path is guarded and
      // the form path is not, which is the same body accepted or rejected
      // depending only on its Content-Type.
      const app = { useBodyParser: jest.fn() };
      applyBodyLimits(app);

      const [, options] = app.useBodyParser.mock.calls.find(
        ([kind]) => kind === 'urlencoded',
      ) as [string, Record<string, unknown>];

      expect(options['depth']).toBe(MAX_BODY_DEPTH);
      expect(options['parameterLimit']).toBe(MAX_URLENCODED_PARAMETERS);
    });

    it('honours an explicit limit', () => {
      const app = { useBodyParser: jest.fn() };
      applyBodyLimits(app, 4096);

      expect(app.useBodyParser).toHaveBeenCalledWith('json', { limit: 4096 });
    });

    it('sets a ceiling above the largest body any DTO permits', () => {
      // CsvImportDto: 5000 rows × ~80 bytes. The bound on *work* stays with
      // the DTOs; this is the bound on bytes, charged before they run.
      expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(5000 * 80);
    });
  });

  describe('resolveCorsOrigin', () => {
    it('passes a single origin through unchanged', () => {
      expect(resolveCorsOrigin('https://gosumo.aiknol.com')).toBe('https://gosumo.aiknol.com');
    });

    it('splits a comma-separated list and trims each entry', () => {
      expect(resolveCorsOrigin('https://a.example, https://b.example')).toEqual([
        'https://a.example',
        'https://b.example',
      ]);
    });

    it('drops empty entries left by a trailing comma', () => {
      // A lone survivor comes back as a plain string, which is the shape the
      // `cors` package serves as a constant header.
      expect(resolveCorsOrigin('https://a.example,')).toBe('https://a.example');
    });

    it('falls back to the wildcard when the var is unset', () => {
      expect(resolveCorsOrigin('*')).toBe('*');
    });

    it('falls back to the wildcard when the var is set but empty', () => {
      // This is the wrapper that reads `process.env`, and `CORS_ORIGIN=` is a
      // *string* — so `?? '*'` never substitutes the default and `''` was what
      // reached `enableCors`. The `cors` package treats any falsy origin as the
      // wildcard while `allowCredentials` saw a named origin and turned
      // credentials on: the forbidden pairing, and silent, because the
      // production warning below only recognises a literal `*`.
      expect(resolveCorsOrigin('')).toBe('*');
    });

    it('trims a single origin so it can match a real Origin header', () => {
      expect(resolveCorsOrigin(' https://gosumo.aiknol.com ')).toBe(
        'https://gosumo.aiknol.com',
      );
    });
  });

  /**
   * `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials:
   * true` is the combination the CORS spec forbids. Dropping credentials rather
   * than narrowing the origin keeps a deployment that never set CORS_ORIGIN
   * working exactly as before.
   */
  describe('allowCredentials', () => {
    it('refuses credentials alongside a wildcard origin', () => {
      expect(allowCredentials('*')).toBe(false);
    });

    it('allows credentials for a named origin', () => {
      expect(allowCredentials('https://gosumo.aiknol.com')).toBe(true);
    });

    it('allows credentials for an origin allow-list', () => {
      expect(allowCredentials(['https://a.example', 'https://b.example'])).toBe(true);
    });
  });

  describe('environment gates', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('treats an unset NODE_ENV as development', () => {
      delete process.env['NODE_ENV'];
      expect(isProduction()).toBe(false);
    });

    it('detects production', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isProduction()).toBe(true);
    });

    /** Swagger publishes every route and DTO — a free map of the API surface. */
    it('serves Swagger outside production', () => {
      process.env['NODE_ENV'] = 'development';
      expect(swaggerEnabled()).toBe(true);
    });

    it('withholds Swagger in production', () => {
      process.env['NODE_ENV'] = 'production';
      delete process.env['ENABLE_SWAGGER'];
      expect(swaggerEnabled()).toBe(false);
    });

    it('re-enables Swagger in production only on an explicit opt-in', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['ENABLE_SWAGGER'] = 'true';
      expect(swaggerEnabled()).toBe(true);
    });

    it('ignores a non-"true" opt-in value', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['ENABLE_SWAGGER'] = '1';
      expect(swaggerEnabled()).toBe(false);
    });

    /**
     * The comparison is case-sensitive. Documented in `.env.example` and
     * DEPLOYMENT.md §4.1 as "the literal true", so a deploy that sets `TRUE`
     * gets the safe outcome rather than an accidental publish.
     */
    it('ignores an opt-in that differs only in case', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['ENABLE_SWAGGER'] = 'TRUE';
      expect(swaggerEnabled()).toBe(false);
    });

    it('leaves Swagger on in development regardless of the opt-in', () => {
      process.env['NODE_ENV'] = 'development';
      process.env['ENABLE_SWAGGER'] = 'false';
      expect(swaggerEnabled()).toBe(true);
    });
  });
});

/**
 * Startup checks.
 *
 * These exist because the settings they cover fail silently: the API comes up,
 * serves traffic, and encrypts credentials — just not with the key the operator
 * thinks. A boot-time line is the only moment anyone looks.
 */
/**
 * HTTP server lifecycle.
 *
 * `enableShutdownHooks()` gets Nest to call `app.close()` on SIGTERM, and
 * `app.close()` calls `server.close()` — which stops accepting new connections
 * and then waits for every existing one to disappear. Caddy's upstream sockets
 * are keep-alive and idle, so they do not, and shutdown stalls until the
 * supervisor SIGKILLs the process. That kill is precisely the ungraceful exit
 * the shutdown hooks were added to avoid: Prisma's pool dropped rather than
 * returned, BullMQ workers cut off mid-job.
 */
describe('configureHttpServerLifecycle', () => {
  let logger: Logger;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger('test');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    log = jest.spyOn(logger, 'log').mockImplementation(() => {});
  });

  /** Capture the signal handlers instead of installing them on the process. */
  function captureSignals() {
    const handlers = new Map<NodeJS.Signals, () => void>();
    return {
      handlers,
      onSignal: (signal: NodeJS.Signals, handler: () => void) => {
        handlers.set(signal, handler);
      },
    };
  }

  it('outlives the proxy keep-alive, and keeps headersTimeout above it', () => {
    const server = { closeIdleConnections: jest.fn() };
    const { onSignal } = captureSignals();

    configureHttpServerLifecycle(server, logger, onSignal);

    // Node's 5s default makes this process the side that hangs up, which loses
    // whatever request Caddy had just chosen that socket for — a 502 from a
    // perfectly healthy backend.
    expect(server).toMatchObject({
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
    });
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it('closes idle connections on every shutdown signal', () => {
    const server = { closeIdleConnections: jest.fn() };
    const { handlers, onSignal } = captureSignals();

    configureHttpServerLifecycle(server, logger, onSignal);

    expect([...handlers.keys()]).toEqual(SHUTDOWN_SIGNALS);
    for (const signal of SHUTDOWN_SIGNALS) {
      handlers.get(signal)!();
    }
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(SHUTDOWN_SIGNALS.length);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('draining in-flight'));
  });

  it('does not touch connections before a signal arrives', () => {
    const server = { closeIdleConnections: jest.fn() };
    const { onSignal } = captureSignals();

    configureHttpServerLifecycle(server, logger, onSignal);

    // Cutting idle sockets during normal operation would be the 502 bug again.
    expect(server.closeIdleConnections).not.toHaveBeenCalled();
  });

  it('shuts down without complaint on a server that cannot close idle sockets', () => {
    const server: Record<string, unknown> = {};
    const { handlers, onSignal } = captureSignals();

    configureHttpServerLifecycle(server, logger, onSignal);

    expect(() => handlers.get('SIGTERM')!()).not.toThrow();
  });

  it('survives a server whose closeIdleConnections throws', () => {
    const server = {
      closeIdleConnections: jest.fn(() => {
        throw new Error('socket teardown failed');
      }),
    };
    const { handlers, onSignal } = captureSignals();

    configureHttpServerLifecycle(server, logger, onSignal);

    // A failure here must not abort the rest of the shutdown sequence.
    expect(() => handlers.get('SIGTERM')!()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket teardown failed'));
  });

  it('warns rather than throwing when there is no HTTP server at all', () => {
    const { handlers, onSignal } = captureSignals();

    configureHttpServerLifecycle(undefined, logger, onSignal);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No HTTP server'));
    expect(handlers.size).toBe(0);
  });
});

describe('runStartupChecks', () => {
  const originalEnv = { ...process.env };
  let logger: Logger;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger('test');
    error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
    });

    it('refuses to start when nothing supplies a key', () => {
      // Booting here would write credentials under a constant that ships in
      // this repository, producing a database that looks encrypted and is not.
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      delete process.env['JWT_SECRET'];

      expect(() => runStartupChecks(logger)).toThrow(/CHANNEL_ENCRYPTION_KEY/);
      expect(error).toHaveBeenCalled();
    });

    it('names the remedy in the failure, not just the problem', () => {
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      delete process.env['JWT_SECRET'];

      expect(() => runStartupChecks(logger)).toThrow(/openssl rand/);
    });

    it('starts but warns when the key is derived from JWT_SECRET', () => {
      // This is the live configuration on an existing deployment, so it must
      // keep booting — the risk is real but it is not "stop the service" real.
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      process.env['JWT_SECRET'] = 'a'.repeat(48);

      expect(() => runStartupChecks(logger)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
    });

    it('warns that rotating JWT_SECRET would silently drop credentials', () => {
      // The part a deployer cannot infer: decryptJson returns {} rather than
      // throwing, so re-keying empties every stored credential with no error.
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      process.env['JWT_SECRET'] = 'a'.repeat(48);
      runStartupChecks(logger);

      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rotating it|silently/i));
    });

    it('warns about a short explicit key without blocking it', () => {
      process.env['CHANNEL_ENCRYPTION_KEY'] = 'short';

      expect(() => runStartupChecks(logger)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('shorter than'));
    });

    it('says nothing when the key is set properly', () => {
      process.env['CHANNEL_ENCRYPTION_KEY'] = 'x'.repeat(48);

      expect(() => runStartupChecks(logger)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('prefers an explicit key over JWT_SECRET', () => {
      process.env['CHANNEL_ENCRYPTION_KEY'] = 'x'.repeat(48);
      process.env['JWT_SECRET'] = 'y'.repeat(48);

      runStartupChecks(logger);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('outside production', () => {
    it('stays silent on a clean checkout', () => {
      // `pnpm dev` on a fresh clone has neither variable and must still run.
      process.env['NODE_ENV'] = 'development';
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      delete process.env['JWT_SECRET'];

      expect(() => runStartupChecks(logger)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('stays silent when NODE_ENV is unset entirely', () => {
      delete process.env['NODE_ENV'];
      delete process.env['CHANNEL_ENCRYPTION_KEY'];
      delete process.env['JWT_SECRET'];

      expect(() => runStartupChecks(logger)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

/**
 * The last error boundary in the process.
 *
 * Nothing listened for either event before this. That is not the same as
 * "neither happens" — Node 15+ defaults to `--unhandled-rejections=throw`, so a
 * single floating promise anywhere in the app took the whole API down, and it
 * did so with no line naming the promise. The two events are handled with
 * opposite verdicts on purpose, and that difference is what these pin.
 */
describe('installProcessSafetyNets', () => {
  let error: jest.SpyInstance;
  let logger: Logger;

  /** A stand-in for `process` so the suite never installs a real handler. */
  function fakeProcess() {
    const handlers: Record<string, Array<(arg: unknown) => void>> = {};
    return {
      handlers,
      on: jest.fn((event: string, handler: (arg: unknown) => void) => {
        (handlers[event] ??= []).push(handler);
      }),
      fire: (event: string, arg: unknown) =>
        (handlers[event] ?? []).forEach((h) => h(arg)),
    };
  }

  beforeEach(() => {
    resetProcessSafetyNets();
    logger = new Logger('test');
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetProcessSafetyNets();
    jest.restoreAllMocks();
  });

  it('listens for both of the events that end a process silently', () => {
    const proc = fakeProcess();
    installProcessSafetyNets(logger, jest.fn(), proc as unknown as NodeJS.EventEmitter);

    expect(Object.keys(proc.handlers).sort()).toEqual([
      'uncaughtException',
      'unhandledRejection',
    ]);
  });

  it('logs an unhandled rejection and keeps the process alive', () => {
    // Most floating promises here are deliberate side paths — a fire-and-forget
    // audit write, a cache refresh. Taking a multi-tenant API down for one of
    // them turns a lost log line into an outage.
    const proc = fakeProcess();
    const onFatal = jest.fn();
    installProcessSafetyNets(logger, onFatal, proc as unknown as NodeJS.EventEmitter);

    proc.fire('unhandledRejection', new Error('audit write failed'));

    expect(onFatal).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled promise rejection'),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('audit write failed'));
  });

  it('reports a rejection that is not an Error at all', () => {
    // `Promise.reject('nope')` and `Promise.reject(undefined)` both reach here,
    // and `reason.message` on either is how the handler itself would throw.
    const proc = fakeProcess();
    installProcessSafetyNets(logger, jest.fn(), proc as unknown as NodeJS.EventEmitter);

    expect(() => proc.fire('unhandledRejection', 'just a string')).not.toThrow();
    expect(() => proc.fire('unhandledRejection', undefined)).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('just a string'));
  });

  it('exits non-zero on an uncaught exception', () => {
    // The opposite call from a rejection: the stack that threw is gone and
    // whatever it was halfway through stays halfway through. Exiting is what
    // tells the supervisor to restart onto known state.
    const proc = fakeProcess();
    const onFatal = jest.fn();
    installProcessSafetyNets(logger, onFatal, proc as unknown as NodeJS.EventEmitter);

    proc.fire('uncaughtException', new Error('bad state'));

    expect(onFatal).toHaveBeenCalledWith(UNCAUGHT_EXCEPTION_EXIT_CODE);
    expect(UNCAUGHT_EXCEPTION_EXIT_CODE).not.toBe(0);
  });

  it('logs the exception before exiting, since installing a handler suppresses Node own printout', () => {
    const proc = fakeProcess();
    const order: string[] = [];
    error.mockImplementation(() => {
      order.push('logged');
    });
    installProcessSafetyNets(
      logger,
      () => order.push('exited'),
      proc as unknown as NodeJS.EventEmitter,
    );

    proc.fire('uncaughtException', new Error('bad state'));

    expect(order).toEqual(['logged', 'exited']);
  });

  it('installs once, so a second call does not double every log line', () => {
    const first = fakeProcess();
    const second = fakeProcess();

    expect(
      installProcessSafetyNets(logger, jest.fn(), first as unknown as NodeJS.EventEmitter),
    ).toBe(true);
    expect(
      installProcessSafetyNets(logger, jest.fn(), second as unknown as NodeJS.EventEmitter),
    ).toBe(false);

    expect(second.on).not.toHaveBeenCalled();
  });
});
