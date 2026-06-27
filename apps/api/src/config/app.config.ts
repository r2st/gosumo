import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  // Application
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  env: process.env['NODE_ENV'] ?? 'development',
  corsOrigin: process.env['CORS_ORIGIN'] ?? '*',

  // Database
  databaseUrl: process.env['DATABASE_URL'],

  // Redis
  redis: {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },

  // JWT
  jwt: {
    secret: process.env['JWT_SECRET'],
    expiration: process.env['JWT_EXPIRATION'] ?? '7d',
  },

  // Google OAuth
  google: {
    clientId: process.env['GOOGLE_CLIENT_ID'],
    clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
    callbackUrl:
      process.env['GOOGLE_CALLBACK_URL'] ?? 'http://localhost:3000/auth/google/callback',
  },

  // Dashboard frontend — OAuth redirects and password-reset links point here
  frontendUrl: process.env['FRONTEND_URL'] ?? 'http://localhost:3001',

  // Anthropic
  anthropic: {
    apiKey: process.env['ANTHROPIC_API_KEY'],
  },

  // Qdrant vector DB
  qdrant: {
    url: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
  },

  // WhatsApp / Meta
  whatsapp: {
    verifyToken: process.env['WHATSAPP_VERIFY_TOKEN'],
    appSecret: process.env['WHATSAPP_APP_SECRET'],
    accessToken: process.env['WHATSAPP_ACCESS_TOKEN'],
    phoneNumberId: process.env['WHATSAPP_PHONE_NUMBER_ID'],
  },

  // Razorpay
  razorpay: {
    keyId: process.env['RAZORPAY_KEY_ID'],
    keySecret: process.env['RAZORPAY_KEY_SECRET'],
    webhookSecret: process.env['RAZORPAY_WEBHOOK_SECRET'],
  },

  // AWS S3
  s3: {
    bucket: process.env['S3_BUCKET'],
    region: process.env['S3_REGION'] ?? 'ap-south-1',
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
  },
}));
