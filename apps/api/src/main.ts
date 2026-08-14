import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

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

async function bootstrap() {
  const logger = new Logger('Bootstrap');

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
