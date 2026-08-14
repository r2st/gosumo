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
    useGlobalPipes: jest.fn(),
    useGlobalFilters: jest.fn(),
    useGlobalInterceptors: jest.fn(),
    enableShutdownHooks: jest.fn(),
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
  allowCredentials,
  isProduction,
  resolveCorsOrigin,
  runStartupChecks,
  swaggerEnabled,
} from './main';

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

  it('enables shutdown hooks before it starts listening', async () => {
    // Without these, Nest never runs onModuleDestroy on a signal: a systemd
    // restart kills the process with Prisma still holding its pool and BullMQ
    // workers mid-job. Postgres only reaps those on its own timeout, and this
    // deployment shares a 50-connection ceiling.
    const app = await (NestFactory.create as jest.Mock).mock.results[0]?.value;

    expect(app.enableShutdownHooks).toHaveBeenCalled();
    expect(app.listen).toHaveBeenCalled();
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
      expect(resolveCorsOrigin('https://a.example,')).toEqual(['https://a.example']);
    });

    it('falls back to the wildcard when the var is unset', () => {
      expect(resolveCorsOrigin('*')).toBe('*');
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
