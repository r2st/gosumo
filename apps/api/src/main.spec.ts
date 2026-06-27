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
});
