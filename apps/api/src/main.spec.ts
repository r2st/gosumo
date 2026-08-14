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

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  allowCredentials,
  isProduction,
  resolveCorsOrigin,
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
