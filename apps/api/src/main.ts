import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  // Global prefix
  app.setGlobalPrefix('v1');

  // CORS
  app.enableCors({
    origin: (process.env['CORS_ORIGIN'] ?? '*').includes(',')
      ? (process.env['CORS_ORIGIN'] ?? '*').split(',').map(s => s.trim())
      : (process.env['CORS_ORIGIN'] ?? '*'),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-correlation-id'],
    credentials: true,
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

  // Swagger
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

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen(port);

  logger.log(`Application running on port ${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/v1/docs`);
  logger.log(`Environment: ${process.env['NODE_ENV'] ?? 'development'}`);
}

bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start application', err);
  process.exit(1);
});
