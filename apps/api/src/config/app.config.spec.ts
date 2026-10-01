/**
 * app.config defaulting tests.
 *
 * The config factory is a wall of `??` fallbacks, which reads as too trivial to
 * test until you notice what it actually encodes: which settings have a safe
 * default and which are meant to arrive undefined so a downstream check can
 * degrade. `transcription.apiKey` silently borrowing `OPENROUTER_API_KEY`, and
 * every credential deliberately staying undefined so its provider drops to
 * simulation mode, are load-bearing behaviours no other test covers.
 *
 * A default that changes by accident — a secret that starts defaulting to a
 * placeholder, a URL that stops pointing at localhost in dev — is close to
 * invisible in review. These pin them.
 *
 * `registerAs` re-invokes the factory on every call, so each test can set the
 * environment and read the result back without reloading the module.
 */

import appConfig from './app.config';

type AppConfig = ReturnType<typeof appConfig>;

/** Keys the factory reads, cleared before each test so defaults are observable. */
const OWNED_ENV_KEYS = [
  'PORT',
  'NODE_ENV',
  'CORS_ORIGIN',
  'API_URL',
  'API_BASE_URL',
  'DATABASE_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'JWT_SECRET',
  'JWT_EXPIRATION',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
  'FRONTEND_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_REFERER',
  'OPENROUTER_TITLE',
  'QDRANT_URL',
  'TRANSCRIPTION_API_URL',
  'TRANSCRIPTION_API_KEY',
  'TRANSCRIPTION_MODEL',
  'IVR_WEBHOOK_SECRET',
  'REALTY_PORTAL_INGEST_TOKEN',
  'REALTY_META_LEADGEN_VERIFY_TOKEN',
  'IVR_GREETING',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'INSTAGRAM_VERIFY_TOKEN',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_PAGE_ID',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'S3_BUCKET',
  'S3_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'EMAIL_API_URL',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'SMS_API_URL',
  'SMS_API_KEY',
  'SMS_SENDER_ID',
  'FCM_API_URL',
  'FCM_SERVER_KEY',
] as const;

describe('app.config', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const key of OWNED_ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  /** Load with the given overrides applied on top of a cleared environment. */
  function load(overrides: Record<string, string> = {}): AppConfig {
    Object.assign(process.env, overrides);
    return appConfig();
  }

  // ─────────────────────────────────────────────
  // Application
  // ─────────────────────────────────────────────

  describe('application settings', () => {
    it('defaults to port 3000 in development with permissive CORS', () => {
      const config = load();

      expect(config.port).toBe(3000);
      expect(config.env).toBe('development');
      expect(config.corsOrigin).toBe('*');
    });

    it('reads the port as a number, not a string', () => {
      expect(load({ PORT: '8080' }).port).toBe(8080);
    });

    it('yields NaN for an unparseable port rather than a silent default', () => {
      // Worth pinning: bootstrap fails loudly on NaN instead of quietly
      // listening on 3000 when someone typos PORT.
      expect(load({ PORT: 'not-a-port' }).port).toBeNaN();
    });

    it('honours an explicit environment and CORS origin', () => {
      const config = load({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://gosumo.aiknol.com',
      });

      expect(config.env).toBe('production');
      expect(config.corsOrigin).toBe('https://gosumo.aiknol.com');
    });
  });

  describe('apiBaseUrl fallback chain', () => {
    it('prefers API_URL', () => {
      expect(
        load({ API_URL: 'https://a.test', API_BASE_URL: 'https://b.test' })
          .apiBaseUrl,
      ).toBe('https://a.test');
    });

    it('falls back to API_BASE_URL', () => {
      expect(load({ API_BASE_URL: 'https://b.test' }).apiBaseUrl).toBe(
        'https://b.test',
      );
    });

    it('falls back to localhost when neither is set', () => {
      expect(load().apiBaseUrl).toBe('http://localhost:3000');
    });
  });

  // ─────────────────────────────────────────────
  // Infrastructure
  // ─────────────────────────────────────────────

  describe('database and redis', () => {
    it('leaves the database URL undefined so startup validation can catch it', () => {
      expect(load().databaseUrl).toBeUndefined();
    });

    it('passes the database URL through', () => {
      expect(load({ DATABASE_URL: 'postgres://x/y' }).databaseUrl).toBe(
        'postgres://x/y',
      );
    });

    it('defaults redis to localhost:6379 with no password', () => {
      expect(load().redis).toEqual({
        host: 'localhost',
        port: 6379,
        password: undefined,
      });
    });

    it('reads redis overrides, with the port as a number', () => {
      expect(
        load({
          REDIS_HOST: 'cache.internal',
          REDIS_PORT: '6380',
          REDIS_PASSWORD: 'secret',
        }).redis,
      ).toEqual({ host: 'cache.internal', port: 6380, password: 'secret' });
    });
  });

  // ─────────────────────────────────────────────
  // Auth
  // ─────────────────────────────────────────────

  describe('jwt and google oauth', () => {
    it('never defaults the JWT secret', () => {
      // A defaulted signing secret would be the same on every deployment.
      expect(load().jwt.secret).toBeUndefined();
    });

    it('defaults token expiration to 7 days', () => {
      expect(load().jwt.expiration).toBe('7d');
    });

    it('honours an explicit expiration', () => {
      expect(load({ JWT_EXPIRATION: '1h' }).jwt.expiration).toBe('1h');
    });

    it('never defaults Google client credentials', () => {
      const { google } = load();

      expect(google.clientId).toBeUndefined();
      expect(google.clientSecret).toBeUndefined();
    });

    it('defaults the Google callback to the local API', () => {
      expect(load().google.callbackUrl).toBe(
        'http://localhost:3000/auth/google/callback',
      );
    });

    it('honours an explicit Google callback', () => {
      expect(
        load({ GOOGLE_CALLBACK_URL: 'https://api.test/auth/google/callback' })
          .google.callbackUrl,
      ).toBe('https://api.test/auth/google/callback');
    });

    it('defaults the dashboard URL to the local frontend port', () => {
      expect(load().frontendUrl).toBe('http://localhost:3001');
    });

    it('honours an explicit dashboard URL', () => {
      expect(
        load({ FRONTEND_URL: 'https://gosumo.aiknol.com' }).frontendUrl,
      ).toBe('https://gosumo.aiknol.com');
    });
  });

  // ─────────────────────────────────────────────
  // AI providers
  // ─────────────────────────────────────────────

  describe('openrouter', () => {
    it('defaults to the OpenRouter chat-completions endpoint with attribution', () => {
      expect(load().openrouter).toEqual({
        apiKey: undefined,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        referer: 'https://gosumo.doaide.com',
        title: 'DoAide Desk',
      });
    });

    it('honours a self-hosted or proxied base URL and attribution', () => {
      expect(
        load({
          OPENROUTER_API_KEY: 'sk-or-1',
          OPENROUTER_BASE_URL: 'https://proxy.test/v1/chat/completions',
          OPENROUTER_REFERER: 'https://staging.test',
          OPENROUTER_TITLE: 'DoAide Desk Staging',
        }).openrouter,
      ).toEqual({
        apiKey: 'sk-or-1',
        baseUrl: 'https://proxy.test/v1/chat/completions',
        referer: 'https://staging.test',
        title: 'DoAide Desk Staging',
      });
    });

    it('defaults Qdrant to the local vector store', () => {
      expect(load().qdrant.url).toBe('http://localhost:6333');
    });

    it('honours an explicit Qdrant URL', () => {
      expect(load({ QDRANT_URL: 'https://qdrant.test' }).qdrant.url).toBe(
        'https://qdrant.test',
      );
    });
  });

  describe('transcription', () => {
    it('defaults to the OpenAI-compatible whisper endpoint', () => {
      const { transcription } = load();

      expect(transcription.apiUrl).toBe(
        'https://api.openai.com/v1/audio/transcriptions',
      );
      expect(transcription.model).toBe('whisper-1');
    });

    it('borrows the OpenRouter key when no transcription key is set', () => {
      // The documented behaviour: one key can serve both.
      expect(load({ OPENROUTER_API_KEY: 'sk-or-1' }).transcription.apiKey).toBe(
        'sk-or-1',
      );
    });

    it('prefers a dedicated transcription key over the OpenRouter one', () => {
      expect(
        load({
          OPENROUTER_API_KEY: 'sk-or-1',
          TRANSCRIPTION_API_KEY: 'sk-whisper',
        }).transcription.apiKey,
      ).toBe('sk-whisper');
    });

    it('leaves the key undefined when neither is set, so transcription simulates', () => {
      expect(load().transcription.apiKey).toBeUndefined();
    });

    it('honours an explicit endpoint and model', () => {
      expect(
        load({
          TRANSCRIPTION_API_URL: 'https://groq.test/v1/audio/transcriptions',
          TRANSCRIPTION_MODEL: 'whisper-large-v3',
        }).transcription,
      ).toMatchObject({
        apiUrl: 'https://groq.test/v1/audio/transcriptions',
        model: 'whisper-large-v3',
      });
    });
  });

  // ─────────────────────────────────────────────
  // Ingress secrets
  // ─────────────────────────────────────────────

  describe('realty ingress', () => {
    it('never defaults any ingress secret', () => {
      // Each gates a @Public() webhook; a default would be a shared bypass.
      expect(load().realty).toEqual({
        ivrWebhookSecret: undefined,
        portalIngestToken: undefined,
        metaLeadgenVerifyToken: undefined,
        ivrGreeting: undefined,
      });
    });

    it('reads the ingress secrets and optional greeting', () => {
      expect(
        load({
          IVR_WEBHOOK_SECRET: 'ivr-secret',
          REALTY_PORTAL_INGEST_TOKEN: 'portal-token',
          REALTY_META_LEADGEN_VERIFY_TOKEN: 'meta-token',
          IVR_GREETING: 'Namaste!',
        }).realty,
      ).toEqual({
        ivrWebhookSecret: 'ivr-secret',
        portalIngestToken: 'portal-token',
        metaLeadgenVerifyToken: 'meta-token',
        ivrGreeting: 'Namaste!',
      });
    });
  });

  describe('channel provider credentials', () => {
    it('never defaults WhatsApp credentials', () => {
      expect(load().whatsapp).toEqual({
        verifyToken: undefined,
        appSecret: undefined,
        accessToken: undefined,
        phoneNumberId: undefined,
      });
    });

    it('reads WhatsApp credentials', () => {
      expect(
        load({
          WHATSAPP_VERIFY_TOKEN: 'vt',
          WHATSAPP_APP_SECRET: 'as',
          WHATSAPP_ACCESS_TOKEN: 'at',
          WHATSAPP_PHONE_NUMBER_ID: 'pn',
        }).whatsapp,
      ).toEqual({
        verifyToken: 'vt',
        appSecret: 'as',
        accessToken: 'at',
        phoneNumberId: 'pn',
      });
    });

    it('never defaults Instagram credentials', () => {
      expect(load().instagram).toEqual({
        verifyToken: undefined,
        appSecret: undefined,
        accessToken: undefined,
        pageId: undefined,
      });
    });

    it('reads Instagram credentials', () => {
      expect(
        load({
          INSTAGRAM_VERIFY_TOKEN: 'vt',
          INSTAGRAM_APP_SECRET: 'as',
          INSTAGRAM_ACCESS_TOKEN: 'at',
          INSTAGRAM_PAGE_ID: 'pg',
        }).instagram,
      ).toEqual({
        verifyToken: 'vt',
        appSecret: 'as',
        accessToken: 'at',
        pageId: 'pg',
      });
    });

    it('never defaults Razorpay credentials', () => {
      expect(load().razorpay).toEqual({
        keyId: undefined,
        keySecret: undefined,
        webhookSecret: undefined,
      });
    });

    it('reads Razorpay credentials', () => {
      expect(
        load({
          RAZORPAY_KEY_ID: 'rzp_test',
          RAZORPAY_KEY_SECRET: 'secret',
          RAZORPAY_WEBHOOK_SECRET: 'whsec',
        }).razorpay,
      ).toEqual({
        keyId: 'rzp_test',
        keySecret: 'secret',
        webhookSecret: 'whsec',
      });
    });
  });

  // ─────────────────────────────────────────────
  // Storage
  // ─────────────────────────────────────────────

  describe('s3', () => {
    it('defaults the region to Mumbai and nothing else', () => {
      expect(load().s3).toEqual({
        bucket: undefined,
        region: 'ap-south-1',
        accessKeyId: undefined,
        secretAccessKey: undefined,
      });
    });

    it('reads bucket, region and credentials', () => {
      expect(
        load({
          S3_BUCKET: 'gosumo-media',
          S3_REGION: 'ap-southeast-1',
          AWS_ACCESS_KEY_ID: 'AKIA',
          AWS_SECRET_ACCESS_KEY: 'shhh',
        }).s3,
      ).toEqual({
        bucket: 'gosumo-media',
        region: 'ap-southeast-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'shhh',
      });
    });
  });

  // ─────────────────────────────────────────────
  // Notification providers
  // ─────────────────────────────────────────────

  describe('notification providers', () => {
    it('defaults sender identities but no provider endpoints or keys', () => {
      // Absent apiUrl/apiKey is what puts each dispatcher into simulation mode.
      const { notification } = load();

      expect(notification.email).toEqual({
        apiUrl: undefined,
        apiKey: undefined,
        from: 'no-reply@gosumo.app',
      });
      expect(notification.sms).toEqual({
        apiUrl: undefined,
        apiKey: undefined,
        senderId: 'GOSUMO',
      });
    });

    it('defaults push to the FCM legacy endpoint with no server key', () => {
      expect(load().notification.push).toEqual({
        fcmUrl: 'https://fcm.googleapis.com/fcm/send',
        serverKey: undefined,
      });
    });

    it('reads email provider settings', () => {
      expect(
        load({
          EMAIL_API_URL: 'https://api.resend.com/emails',
          EMAIL_API_KEY: 're_1',
          EMAIL_FROM: 'hello@shop.in',
        }).notification.email,
      ).toEqual({
        apiUrl: 'https://api.resend.com/emails',
        apiKey: 're_1',
        from: 'hello@shop.in',
      });
    });

    it('reads sms provider settings', () => {
      expect(
        load({
          SMS_API_URL: 'https://api.msg91.com/send',
          SMS_API_KEY: 'msg91-key',
          SMS_SENDER_ID: 'SHOPIN',
        }).notification.sms,
      ).toEqual({
        apiUrl: 'https://api.msg91.com/send',
        apiKey: 'msg91-key',
        senderId: 'SHOPIN',
      });
    });

    it('reads push provider settings', () => {
      expect(
        load({
          FCM_API_URL: 'https://fcm.test/send',
          FCM_SERVER_KEY: 'fcm-key',
        }).notification.push,
      ).toEqual({ fcmUrl: 'https://fcm.test/send', serverKey: 'fcm-key' });
    });
  });

  // ─────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────

  it('registers under the "app" namespace', () => {
    // Every consumer reads `configService.get('app.<key>')`.
    expect(appConfig.KEY).toBe('CONFIGURATION(app)');
  });

  it('re-reads the environment on each call', () => {
    expect(load({ PORT: '4000' }).port).toBe(4000);
    expect(load({ PORT: '5000' }).port).toBe(5000);
  });
});
