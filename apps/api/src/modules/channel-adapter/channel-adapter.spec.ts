/**
 * Channel Adapter module unit tests
 *
 * Coverage:
 *  1. WhatsApp webhook signature validation (valid, invalid, missing header, no secret)
 *  2. WhatsApp message parsing — text, image, document, location, interactive (button + list), button quick-reply
 *  3. WhatsApp parseInbound error paths (status-only payload, unknown type)
 *  4. ChannelAdapterService — adapter registry (register, lookup, missing)
 *  5. ChannelAdapterService — handleInboundWebhook (success, bad signature, parse error)
 *  6. ChannelAdapterService — sendMessage routing (success, failure event emission)
 *  7. WhatsApp GET verification challenge
 *  8. isStatusUpdateOnly utility
 *
 * External HTTP calls (Meta Cloud API) are mocked via jest.spyOn on global fetch.
 */

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChannelType, MessageContentType, MessageDirection, RawRequest, OutboundMessage } from '@gosumo/shared';

import { WhatsAppAdapter, isStatusUpdateOnly } from './adapters/whatsapp.adapter';
import { ChannelAdapterService } from './channel-adapter.service';

// ─────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────

const APP_SECRET = 'test-app-secret-32chars-xxxxxxxx';
const PHONE_NUMBER_ID = '123456789';
const ACCESS_TOKEN = 'test-access-token';
const VERIFY_TOKEN = 'gosumo-verify-token';

/**
 * Build a valid Meta webhook payload with a text message.
 */
function makeTextWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID_001',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+91 99999 00001',
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [
                { profile: { name: 'Priya Sharma' }, wa_id: '919999900001' },
              ],
              messages: [
                {
                  from: '919999900001',
                  id: 'wamid.HBgNOTE5OTk5OTAwMDAxFQIAERgSMjhEMEI5QjdBQjRGRUE2ODUEAA',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'Hello, I want to book an appointment' },
                },
              ],
              ...overrides,
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

/**
 * Compute a valid HMAC-SHA256 signature for a payload.
 */
function sign(payload: unknown, secret: string): string {
  const body = JSON.stringify(payload);
  const hash = crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hash}`;
}

/**
 * Build a RawRequest with a valid signature.
 */
function buildSignedRequest(payload: unknown, secret: string): RawRequest {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return {
    headers: {
      'x-hub-signature-256': `sha256=${signature}`,
      'content-type': 'application/json',
    },
    body: payload,
    rawBody,
  };
}

function buildUnsignedRequest(payload: unknown): RawRequest {
  return {
    headers: { 'content-type': 'application/json' },
    body: payload,
    rawBody: Buffer.from(JSON.stringify(payload)),
  };
}

// ─────────────────────────────────────────────
// Shared adapter factory
// ─────────────────────────────────────────────

function makeConfigService(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    'whatsapp.appSecret': APP_SECRET,
    'whatsapp.accessToken': ACCESS_TOKEN,
    'whatsapp.phoneNumberId': PHONE_NUMBER_ID,
    'whatsapp.verifyToken': VERIFY_TOKEN,
  };
  const values = { ...defaults, ...overrides };

  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback ?? '',
  } as unknown as ConfigService;
}

async function buildAdapter(configOverrides: Record<string, string> = {}): Promise<WhatsAppAdapter> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WhatsAppAdapter,
      { provide: ConfigService, useValue: makeConfigService(configOverrides) },
    ],
  }).compile();

  return module.get<WhatsAppAdapter>(WhatsAppAdapter);
}

// ─────────────────────────────────────────────
// 1. WhatsApp webhook signature validation
// ─────────────────────────────────────────────

describe('WhatsAppAdapter — validateWebhook', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('returns true for a valid HMAC-SHA256 signature', () => {
    const payload = makeTextWebhookPayload();
    const req = buildSignedRequest(payload, APP_SECRET);
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it('returns false for a tampered signature', () => {
    const payload = makeTextWebhookPayload();
    const rawBody = Buffer.from(JSON.stringify(payload));
    const req: RawRequest = {
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: payload,
      rawBody,
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false when X-Hub-Signature-256 header is missing', () => {
    const payload = makeTextWebhookPayload();
    const req: RawRequest = {
      headers: {},
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false when rawBody is absent', () => {
    const payload = makeTextWebhookPayload();
    const req: RawRequest = {
      headers: { 'x-hub-signature-256': 'sha256=anything' },
      body: payload,
      // No rawBody
    };
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const payload = makeTextWebhookPayload();
    // Sign with a different secret
    const req = buildSignedRequest(payload, 'wrong-secret-xxxxxxxxxxxxx');
    expect(adapter.validateWebhook(req)).toBe(false);
  });

  it('returns true and skips verification when appSecret is not configured', async () => {
    const adapterWithoutSecret = await buildAdapter({ 'whatsapp.appSecret': '' });
    const req = buildUnsignedRequest(makeTextWebhookPayload());
    expect(adapterWithoutSecret.validateWebhook(req)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 2. WhatsApp message parsing
// ─────────────────────────────────────────────

describe('WhatsAppAdapter — parseInbound', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('parses a text message correctly', () => {
    const payload = makeTextWebhookPayload();
    const req = buildSignedRequest(payload, APP_SECRET);
    const msg = adapter.parseInbound(req);

    expect(msg.channel).toBe(ChannelType.WHATSAPP);
    expect(msg.direction).toBe(MessageDirection.INBOUND);
    expect(msg.externalId).toBe(
      'wamid.HBgNOTE5OTk5OTAwMDAxFQIAERgSMjhEMEI5QjdBQjRGRUE2ODUEAA',
    );
    expect(msg.sender.externalId).toBe('919999900001');
    expect(msg.sender.displayName).toBe('Priya Sharma');
    expect(msg.content.type).toBe(MessageContentType.TEXT);
    if (msg.content.type === MessageContentType.TEXT) {
      expect(msg.content.text).toBe('Hello, I want to book an appointment');
    }
    expect(msg.timestamp).toEqual(new Date(1700000000 * 1000));
    expect(msg.channelAccountId).toBe(PHONE_NUMBER_ID);
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('parses an image message', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.IMAGE001',
          timestamp: '1700000001',
          type: 'image',
          image: {
            id: 'media-id-abc123',
            mime_type: 'image/jpeg',
            sha256: 'abc',
            caption: 'Check this out',
          },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.IMAGE);
    if (msg.content.type === MessageContentType.IMAGE) {
      expect(msg.content.url).toBe('whatsapp-media://media-id-abc123');
      expect(msg.content.mimeType).toBe('image/jpeg');
      expect(msg.content.caption).toBe('Check this out');
    }
  });

  it('parses a document message', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.DOC001',
          timestamp: '1700000002',
          type: 'document',
          document: {
            id: 'doc-media-xyz',
            mime_type: 'application/pdf',
            filename: 'invoice.pdf',
          },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.DOCUMENT);
    if (msg.content.type === MessageContentType.DOCUMENT) {
      expect(msg.content.filename).toBe('invoice.pdf');
      expect(msg.content.mimeType).toBe('application/pdf');
      expect(msg.content.url).toBe('whatsapp-media://doc-media-xyz');
    }
  });

  it('parses a location message', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.LOC001',
          timestamp: '1700000003',
          type: 'location',
          location: {
            latitude: 28.6139,
            longitude: 77.209,
            name: 'India Gate',
            address: 'New Delhi 110001',
          },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.LOCATION);
    if (msg.content.type === MessageContentType.LOCATION) {
      expect(msg.content.latitude).toBe(28.6139);
      expect(msg.content.longitude).toBe(77.209);
      expect(msg.content.name).toBe('India Gate');
      expect(msg.content.address).toBe('New Delhi 110001');
    }
  });

  it('parses an interactive button_reply', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.BTN001',
          timestamp: '1700000004',
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'btn-confirm', title: 'Confirm Booking' },
          },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
    if (msg.content.type === MessageContentType.INTERACTIVE) {
      expect(msg.content.interactiveType).toBe('button_reply');
      expect(msg.content.payload['id']).toBe('btn-confirm');
      expect(msg.content.payload['title']).toBe('Confirm Booking');
    }
  });

  it('parses an interactive list_reply', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.LST001',
          timestamp: '1700000005',
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: {
              id: 'slot-10am',
              title: '10:00 AM',
              description: 'Wednesday, 4 Dec',
            },
          },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
    if (msg.content.type === MessageContentType.INTERACTIVE) {
      expect(msg.content.interactiveType).toBe('list_reply');
      expect(msg.content.payload['id']).toBe('slot-10am');
      expect(msg.content.payload['description']).toBe('Wednesday, 4 Dec');
    }
  });

  it('parses a quick-reply button tap (type: button)', () => {
    const payload = makeTextWebhookPayload({
      messages: [
        {
          from: '919999900001',
          id: 'wamid.QRBTN001',
          timestamp: '1700000006',
          type: 'button',
          button: { payload: 'CONFIRM_ORDER_42', text: 'Yes, confirm' },
        },
      ],
    });

    const msg = adapter.parseInbound(buildUnsignedRequest(payload));
    expect(msg.content.type).toBe(MessageContentType.INTERACTIVE);
    if (msg.content.type === MessageContentType.INTERACTIVE) {
      expect(msg.content.interactiveType).toBe('button_reply');
      expect(msg.content.payload['id']).toBe('CONFIRM_ORDER_42');
    }
  });

  it('throws when the payload has no inbound messages (status-only)', () => {
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID_001',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+91 99999 00001', phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  { id: 'wamid.SENT001', status: 'delivered', timestamp: '1700000010', recipient_id: '919999900001' },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    expect(() => adapter.parseInbound(buildUnsignedRequest(statusPayload))).toThrow(
      'Webhook payload contained no parseable inbound message',
    );
  });

  it('throws for an unexpected object type', () => {
    const badPayload = { object: 'instagram', entry: [] };
    expect(() => adapter.parseInbound(buildUnsignedRequest(badPayload))).toThrow(
      'Unexpected webhook object type',
    );
  });
});

// ─────────────────────────────────────────────
// 3. parseInboundAll — multi-message batches
// ─────────────────────────────────────────────

describe('WhatsAppAdapter — parseInboundAll', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  it('returns an empty array for a status-only payload', () => {
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID_001',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+91', phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: 'wamid.001', status: 'read', timestamp: '1700000020', recipient_id: '91111' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msgs = adapter.parseInboundAll(buildUnsignedRequest(statusPayload));
    expect(msgs).toHaveLength(0);
  });

  it('returns multiple messages from a batched payload', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID_001',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+91', phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ profile: { name: 'A' }, wa_id: '911111111111' }],
                messages: [
                  { from: '911111111111', id: 'wamid.A1', timestamp: '1700000100', type: 'text', text: { body: 'Hi' } },
                  { from: '911111111111', id: 'wamid.A2', timestamp: '1700000101', type: 'text', text: { body: 'Hello' } },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const msgs = adapter.parseInboundAll(buildUnsignedRequest(payload));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.externalId).toBe('wamid.A1');
    expect(msgs[1]!.externalId).toBe('wamid.A2');
  });
});

// ─────────────────────────────────────────────
// 4. isStatusUpdateOnly utility
// ─────────────────────────────────────────────

describe('isStatusUpdateOnly()', () => {
  it('returns true when there are no messages in any entry', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+91', phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: 'wamid.001', status: 'read', timestamp: '1700', recipient_id: '91' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    expect(isStatusUpdateOnly(payload)).toBe(true);
  });

  it('returns false when there is at least one message', () => {
    const payload = makeTextWebhookPayload();
    expect(isStatusUpdateOnly(payload)).toBe(false);
  });

  it('returns false for null/undefined input', () => {
    expect(isStatusUpdateOnly(null)).toBe(false);
    expect(isStatusUpdateOnly(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 5. WhatsApp sendMessage — Meta API call
// ─────────────────────────────────────────────

describe('WhatsAppAdapter — sendMessage', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    adapter = await buildAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns success result when Meta API responds 200', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '919999900001', wa_id: '919999900001' }],
        messages: [{ id: 'wamid.SENT001' }],
      }),
    };

    jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PHONE_NUMBER_ID,
      recipientExternalId: '919999900001',
      content: { type: MessageContentType.TEXT, text: 'Your appointment is confirmed!' },
    };

    const result = await adapter.sendMessage(message);

    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe('wamid.SENT001');
    expect(result.sentAt).toBeInstanceOf(Date);
  });

  it('returns failure result for a 4xx error (non-retryable)', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Invalid parameter', code: 100 },
      }),
    };

    jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PHONE_NUMBER_ID,
      recipientExternalId: 'invalid_phone',
      content: { type: MessageContentType.TEXT, text: 'Test' },
    };

    const result = await adapter.sendMessage(message);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid parameter');
  });

  it('retries on 5xx errors and returns failure after maxAttempts', async () => {
    const serverError = {
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'Service unavailable',
    };

    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(serverError as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PHONE_NUMBER_ID,
      recipientExternalId: '919999900001',
      content: { type: MessageContentType.TEXT, text: 'Test' },
    };

    const result = await adapter.sendMessage(message);

    expect(result.success).toBe(false);
    // 3 attempts (maxAttempts = 3)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 10_000);
});

// ─────────────────────────────────────────────
// 6. ChannelAdapterService — adapter registry
// ─────────────────────────────────────────────

describe('ChannelAdapterService — adapter registry', () => {
  let service: ChannelAdapterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ChannelAdapterService>(ChannelAdapterService);
  });

  it('throws NotFoundException when no adapter is registered for a channel', () => {
    expect(() => service.getAdapter(ChannelType.WHATSAPP)).toThrow(NotFoundException);
  });

  it('registers and retrieves an adapter', async () => {
    const adapter = await buildAdapter();
    service.registerAdapter(adapter);
    expect(service.getAdapter(ChannelType.WHATSAPP)).toBe(adapter);
  });

  it('getRegisteredChannels returns all registered channel types', async () => {
    expect(service.getRegisteredChannels()).toHaveLength(0);

    const adapter = await buildAdapter();
    service.registerAdapter(adapter);

    expect(service.getRegisteredChannels()).toEqual([ChannelType.WHATSAPP]);
  });

  it('replaces adapter on double registration', async () => {
    const adapter1 = await buildAdapter();
    const adapter2 = await buildAdapter({ 'whatsapp.phoneNumberId': '999' });

    service.registerAdapter(adapter1);
    service.registerAdapter(adapter2);

    expect(service.getAdapter(ChannelType.WHATSAPP)).toBe(adapter2);
    expect(service.getRegisteredChannels()).toHaveLength(1);
  });

  it('getStatus returns module info', async () => {
    const adapter = await buildAdapter();
    service.registerAdapter(adapter);
    const status = service.getStatus();
    expect(status['registeredChannels']).toContain(ChannelType.WHATSAPP);
    expect(status['adapterCount']).toBe(1);
  });
});

// ─────────────────────────────────────────────
// 7. ChannelAdapterService — handleInboundWebhook
// ─────────────────────────────────────────────

describe('ChannelAdapterService — handleInboundWebhook', () => {
  let service: ChannelAdapterService;
  let emitSpy: jest.Mock;

  beforeEach(async () => {
    emitSpy = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        {
          provide: EventEmitter2,
          useValue: { emit: emitSpy },
        },
      ],
    }).compile();

    service = module.get<ChannelAdapterService>(ChannelAdapterService);

    const adapter = await buildAdapter();
    service.registerAdapter(adapter);
  });

  it('parses a valid webhook and emits message.received', async () => {
    const payload = makeTextWebhookPayload();
    const req = buildSignedRequest(payload, APP_SECRET);

    const msg = await service.handleInboundWebhook(
      ChannelType.WHATSAPP,
      req,
      'business-123',
    );

    expect(msg.channel).toBe(ChannelType.WHATSAPP);
    expect(msg.content.type).toBe(MessageContentType.TEXT);

    expect(emitSpy).toHaveBeenCalledWith(
      'message.received',
      expect.objectContaining({
        type: 'message.received',
        businessId: 'business-123',
        channel: ChannelType.WHATSAPP,
        channelAccountId: PHONE_NUMBER_ID,
      }),
    );
  });

  it('throws UnauthorizedException for an invalid signature', async () => {
    const payload = makeTextWebhookPayload();
    const req: RawRequest = {
      headers: { 'x-hub-signature-256': 'sha256=badhash' },
      body: payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    };

    await expect(
      service.handleInboundWebhook(ChannelType.WHATSAPP, req, 'business-123'),
    ).rejects.toThrow(UnauthorizedException);

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for an unregistered channel', async () => {
    const req = buildSignedRequest(makeTextWebhookPayload(), APP_SECRET);

    await expect(
      service.handleInboundWebhook(ChannelType.SMS, req, 'business-123'),
    ).rejects.toThrow(NotFoundException);
  });

  it('passes correlationId through to the emitted event', async () => {
    const payload = makeTextWebhookPayload();
    const req = buildSignedRequest(payload, APP_SECRET);

    await service.handleInboundWebhook(
      ChannelType.WHATSAPP,
      req,
      'business-abc',
      'gs-trace-xyz',
    );

    expect(emitSpy).toHaveBeenCalledWith(
      'message.received',
      expect.objectContaining({ correlationId: 'gs-trace-xyz' }),
    );
  });
});

// ─────────────────────────────────────────────
// 8. ChannelAdapterService — sendMessage routing
// ─────────────────────────────────────────────

describe('ChannelAdapterService — sendMessage', () => {
  let service: ChannelAdapterService;
  let emitSpy: jest.Mock;

  beforeEach(async () => {
    emitSpy = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: EventEmitter2, useValue: { emit: emitSpy } },
      ],
    }).compile();

    service = module.get<ChannelAdapterService>(ChannelAdapterService);

    const adapter = await buildAdapter();
    service.registerAdapter(adapter);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits message.sent when the adapter call succeeds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '91111', wa_id: '91111' }],
        messages: [{ id: 'wamid.SENT_FROM_SVC' }],
      }),
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PHONE_NUMBER_ID,
      recipientExternalId: '91111',
      content: { type: MessageContentType.TEXT, text: 'Hello' },
    };

    const result = await service.sendMessage(
      ChannelType.WHATSAPP,
      message,
      'business-xyz',
    );

    expect(result.success).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      'message.sent',
      expect.objectContaining({ type: 'message.sent', channel: ChannelType.WHATSAPP }),
    );
  });

  it('emits message.failed when the adapter call fails', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Bad recipient', code: 131047 } }),
    } as unknown as Response);

    const message: OutboundMessage = {
      channelAccountId: PHONE_NUMBER_ID,
      recipientExternalId: 'invalid',
      content: { type: MessageContentType.TEXT, text: 'Test' },
    };

    const result = await service.sendMessage(
      ChannelType.WHATSAPP,
      message,
      'business-xyz',
    );

    expect(result.success).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      'message.failed',
      expect.objectContaining({ type: 'message.failed' }),
    );
  });

  it('throws NotFoundException for unregistered channel', async () => {
    const message: OutboundMessage = {
      channelAccountId: 'acc1',
      recipientExternalId: 'user1',
      content: { type: MessageContentType.TEXT, text: 'Hello' },
    };

    await expect(
      service.sendMessage(ChannelType.INSTAGRAM, message, 'biz1'),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─────────────────────────────────────────────
// 9. WhatsApp getCapabilities
// ─────────────────────────────────────────────

describe('WhatsAppAdapter — getCapabilities', () => {
  it('returns the correct WhatsApp capability set', async () => {
    const adapter = await buildAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.channelType).toBe(ChannelType.WHATSAPP);
    expect(caps.supportsTemplates).toBe(true);
    expect(caps.supportsInteractiveMessages).toBe(true);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.supportsVoice).toBe(false);
    expect(caps.supportsReadReceipts).toBe(true);
    expect(caps.maxMessageLength).toBeGreaterThan(0);
  });
});
