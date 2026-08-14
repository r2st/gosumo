/**
 * Shared end-to-end test harness for the channel-adapter module.
 *
 * Boots a *real* NestJS application containing the webhook controller, the
 * ChannelAdapterService, every channel adapter, and the WebChat Socket.IO
 * gateway. External I/O is faked at the edges only:
 *   - PrismaService is replaced with an in-memory jest mock (no database)
 *   - global.fetch is mocked per-test for outbound provider calls
 *   - EventEmitter2 is real, so domain events flow exactly as in production
 *
 * The app is created with `{ rawBody: true }` so `req.rawBody` is populated —
 * this is what the Meta/Instagram HMAC-SHA256 signature check verifies against.
 *
 * Everything else (HTTP routing, ValidationPipe, DTO validation, controller →
 * service → adapter wiring, event emission) runs end to end through the network
 * stack via supertest / socket.io-client.
 */
import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import type { AddressInfo } from 'net';

import { ChannelAdapterController } from '../../../src/modules/channel-adapter/channel-adapter.controller';
import { ChannelAdapterService } from '../../../src/modules/channel-adapter/channel-adapter.service';
import { WhatsAppAdapter } from '../../../src/modules/channel-adapter/adapters/whatsapp.adapter';
import { InstagramAdapter } from '../../../src/modules/channel-adapter/adapters/instagram.adapter';
import { SmsAdapter } from '../../../src/modules/channel-adapter/adapters/sms.adapter';
import { EmailAdapter } from '../../../src/modules/channel-adapter/adapters/email.adapter';
import { WebChatAdapter } from '../../../src/modules/channel-adapter/adapters/webchat.adapter';
import { WebChatGateway } from '../../../src/modules/channel-adapter/gateways/webchat.gateway';
import { WebChatThrottle } from '../../../src/modules/channel-adapter/gateways/webchat-throttle';
import { PrismaService } from '../../../src/common/services/prisma.service';

// ─────────────────────────────────────────────
// Shared test config values (secrets, tokens, ids)
// ─────────────────────────────────────────────

export const TEST_CONFIG = {
  // Signing key for WebChat session tokens. Production reuses JWT_SECRET; the
  // gateway fails closed without it, so the harness must supply one.
  'jwt.secret': 'e2e-jwt-secret-32-chars-cccccccccc',
  // Instagram
  'instagram.appSecret': 'ig-app-secret-32-chars-aaaaaaaaaa',
  'instagram.accessToken': 'ig-access-token',
  'instagram.pageId': '17841400000000000',
  'instagram.verifyToken': 'gosumo-ig-verify-token',
  // WhatsApp
  'whatsapp.appSecret': 'wa-app-secret-32-chars-bbbbbbbbbb',
  'whatsapp.accessToken': 'wa-access-token',
  'whatsapp.phoneNumberId': '123456789',
  'whatsapp.verifyToken': 'gosumo-wa-verify-token',
  // SMS (Twilio)
  'twilio.accountSid': 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'twilio.authToken': 'twilio-auth-token',
  'twilio.fromNumber': '+15550001111',
  // Email (SendGrid)
  'sendgrid.apiKey': 'SG.test-key',
  'sendgrid.fromEmail': 'support@gosumo.app',
  'sendgrid.fromName': 'GoSumo',
} as const;

export interface CapturedEvent {
  name: string;
  payload: unknown;
}

/**
 * Build a jest-mocked PrismaService. Defaults make `handleInboundWebhook`
 * take the "no channel_account resolved" branch (emits a partial event without
 * touching the DB). Pass overrides to drive the WebChat gateway path.
 */
export function makePrismaMock(
  overrides: Record<string, Record<string, jest.Mock>> = {},
): Record<string, Record<string, jest.Mock>> {
  const base = {
    channel_accounts: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    channel_contacts: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'cc-1', client_id: 'client-1' }),
      update: jest.fn().mockResolvedValue({ id: 'cc-1', client_id: 'client-1' }),
    },
    clients: {
      create: jest.fn().mockResolvedValue({ id: 'client-1' }),
    },
    conversations: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      update: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    },
    messages: {
      create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
    },
  };

  for (const [model, methods] of Object.entries(overrides)) {
    base[model as keyof typeof base] = {
      ...(base[model as keyof typeof base] ?? {}),
      ...methods,
    } as never;
  }

  return base;
}

export interface E2EHarness {
  app: INestApplication;
  module: TestingModule;
  emitter: EventEmitter2;
  /** Every domain event emitted on the bus, in order. */
  events: CapturedEvent[];
  prisma: Record<string, Record<string, jest.Mock>>;
  /** Base URL of the listening server, e.g. http://127.0.0.1:54231 */
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

export interface CreateHarnessOptions {
  /** Override individual config keys (e.g. disable a secret). */
  config?: Partial<Record<string, string>>;
  /** Prisma method overrides (model -> method -> jest.Mock). */
  prisma?: Record<string, Record<string, jest.Mock>>;
}

/**
 * Boot the channel-adapter app and start listening on an ephemeral port.
 */
export async function createHarness(options: CreateHarnessOptions = {}): Promise<E2EHarness> {
  const configValues: Record<string, string> = { ...TEST_CONFIG, ...(options.config ?? {}) };

  const configMock = {
    get: (key: string, fallback?: string): string =>
      configValues[key] ?? fallback ?? '',
  } as unknown as ConfigService;

  const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
  const events: CapturedEvent[] = [];
  emitter.onAny((name: string | string[], ...values: unknown[]) => {
    events.push({ name: Array.isArray(name) ? name.join('.') : name, payload: values[0] });
  });

  const prisma = makePrismaMock(options.prisma);

  const module: TestingModule = await Test.createTestingModule({
    controllers: [ChannelAdapterController],
    providers: [
      ChannelAdapterService,
      WhatsAppAdapter,
      InstagramAdapter,
      SmsAdapter,
      EmailAdapter,
      WebChatAdapter,
      WebChatGateway,
      WebChatThrottle,
      { provide: ConfigService, useValue: configMock },
      { provide: EventEmitter2, useValue: emitter },
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();

  const app = module.createNestApplication({ rawBody: true });

  // Mirror the production global ValidationPipe (main.ts)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // The real ChannelAdapterModule registers every adapter in onModuleInit();
  // replicate that here since we build a focused testing module.
  const service = module.get(ChannelAdapterService);
  service.registerAdapter(module.get(WhatsAppAdapter));
  service.registerAdapter(module.get(InstagramAdapter));
  service.registerAdapter(module.get(SmsAdapter));
  service.registerAdapter(module.get(EmailAdapter));
  service.registerAdapter(module.get(WebChatAdapter));

  await app.listen(0);

  const server = app.getHttpServer();
  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    module,
    emitter,
    events,
    prisma,
    baseUrl,
    port,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Compute the `X-Hub-Signature-256` header value Meta/Instagram would send
 * for a given raw request body and app secret.
 */
export function signMetaBody(rawBody: string, appSecret: string): string {
  const hash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `sha256=${hash}`;
}

/** Mock a single global.fetch resolution (a successful JSON response). */
export function mockFetchJsonOnce(status: number, json: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  } as unknown as Response);
}
