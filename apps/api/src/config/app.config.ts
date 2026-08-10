import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  // Application
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  env: process.env['NODE_ENV'] ?? 'development',
  corsOrigin: process.env['CORS_ORIGIN'] ?? '*',
  apiBaseUrl: process.env['API_URL'] ?? process.env['API_BASE_URL'] ?? 'http://localhost:3000',

  // Database
  databaseUrl: process.env['DATABASE_URL'],

  // Redis
  redis: {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    password: process.env['REDIS_PASSWORD'],
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

  // OpenRouter — LLM provider (OpenAI-compatible chat completions, free models)
  openrouter: {
    apiKey: process.env['OPENROUTER_API_KEY'],
    baseUrl: process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1/chat/completions',
    // Attribution headers OpenRouter uses for its dashboard/rankings.
    referer: process.env['OPENROUTER_REFERER'] ?? 'https://gosumo.aiknol.com',
    title: process.env['OPENROUTER_TITLE'] ?? 'GoSumo',
  },

  // Qdrant vector DB
  qdrant: {
    url: process.env['QDRANT_URL'] ?? 'http://localhost:6333',
  },

  // Speech-to-text (voice-note transcription). OpenAI-compatible
  // /audio/transcriptions endpoint (OpenRouter, Groq Whisper, or self-hosted).
  // When the key is absent the transcriber runs in a no-op/simulation mode.
  transcription: {
    apiUrl:
      process.env['TRANSCRIPTION_API_URL'] ?? 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: process.env['TRANSCRIPTION_API_KEY'] ?? process.env['OPENROUTER_API_KEY'],
    model: process.env['TRANSCRIPTION_MODEL'] ?? 'whisper-1',
  },

  // GoSumo Realty ingress secrets. `ivrWebhookSecret` verifies the HMAC on the
  // missed-call → WhatsApp IVR webhook; `portalIngestToken` gates the portal
  // enquiry webhook; `metaLeadgenVerifyToken` is the Meta GET-challenge token.
  realty: {
    ivrWebhookSecret: process.env['IVR_WEBHOOK_SECRET'],
    portalIngestToken: process.env['REALTY_PORTAL_INGEST_TOKEN'],
    metaLeadgenVerifyToken: process.env['REALTY_META_LEADGEN_VERIFY_TOKEN'],
    // Optional default greeting for a fresh IVR missed call (before enrichment).
    ivrGreeting: process.env['IVR_GREETING'],
  },

  // WhatsApp / Meta
  whatsapp: {
    verifyToken: process.env['WHATSAPP_VERIFY_TOKEN'],
    appSecret: process.env['WHATSAPP_APP_SECRET'],
    accessToken: process.env['WHATSAPP_ACCESS_TOKEN'],
    phoneNumberId: process.env['WHATSAPP_PHONE_NUMBER_ID'],
  },

  // Instagram / Meta Messaging
  instagram: {
    verifyToken: process.env['INSTAGRAM_VERIFY_TOKEN'],
    appSecret: process.env['INSTAGRAM_APP_SECRET'],
    accessToken: process.env['INSTAGRAM_ACCESS_TOKEN'],
    pageId: process.env['INSTAGRAM_PAGE_ID'],
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

  // Notification channel providers. When a provider's credentials are absent
  // the dispatcher runs in "simulation" mode (logs + synthetic message id) so
  // the rest of the pipeline still works in dev/test.
  notification: {
    email: {
      apiUrl: process.env['EMAIL_API_URL'], // e.g. https://api.resend.com/emails
      apiKey: process.env['EMAIL_API_KEY'],
      from: process.env['EMAIL_FROM'] ?? 'no-reply@gosumo.app',
    },
    sms: {
      apiUrl: process.env['SMS_API_URL'], // e.g. MSG91 / Twilio endpoint
      apiKey: process.env['SMS_API_KEY'],
      senderId: process.env['SMS_SENDER_ID'] ?? 'GOSUMO',
    },
    push: {
      fcmUrl:
        process.env['FCM_API_URL'] ?? 'https://fcm.googleapis.com/fcm/send',
      serverKey: process.env['FCM_SERVER_KEY'],
    },
  },
}));
