/**
 * ChannelAdapterService — defensive branches.
 *
 * The main spec drives the service through the real WhatsApp adapter, which
 * means the paths that only open when an adapter misbehaves are hard to reach:
 * a parser that throws, a "success" result with no provider message id, a
 * failure with no reason or attempt count. Those are exactly the shapes a
 * third-party or newly written adapter produces, and the service is what stops
 * them turning into `undefined` inside a domain event other modules consume.
 *
 * A stub adapter lets each of those be stated directly.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelType,
  MessageContentType,
  MessageDirection,
  NormalizedMessage,
  OutboundMessage,
  RawRequest,
  SendResult,
} from '@gosumo/shared';

import { ChannelAdapterService } from './channel-adapter.service';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = 'acct-1';

function makeMockPrisma(): {
  service: PrismaService;
  webhookCreate: jest.Mock;
} {
  const webhookCreate = jest.fn().mockResolvedValue({ id: 'evt_1' });
  return {
    webhookCreate,
    service: {
      channel_accounts: { findFirst: jest.fn().mockResolvedValue(null) },
      channel_contacts: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      clients: { create: jest.fn() },
      conversations: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      messages: { create: jest.fn() },
      webhook_events: { create: webhookCreate },
    } as unknown as PrismaService,
  };
}

/** Minimal adapter whose every method is a jest.fn the test can steer. */
class StubAdapter implements ChannelAdapter {
  readonly channelType = ChannelType.SMS;

  validateWebhook = jest.fn<boolean, [RawRequest]>().mockReturnValue(true);
  parseInbound = jest.fn<NormalizedMessage, [RawRequest]>().mockReturnValue({
    externalId: 'ext-1',
    channel: ChannelType.SMS,
    channelAccountId: ACCOUNT_ID,
    direction: MessageDirection.INBOUND,
    sender: { externalId: '919876543210', name: 'Ravi' },
    content: { type: MessageContentType.TEXT, text: 'hi' },
    timestamp: new Date('2026-07-01T00:00:00Z'),
    raw: {},
  } as unknown as NormalizedMessage);
  sendMessage = jest.fn<Promise<SendResult>, [OutboundMessage]>();
  sendTemplate = jest.fn();
  sendInteractive = jest.fn();
  getCapabilities = jest.fn<ChannelCapabilities, []>();
  downloadMedia = jest.fn();
  uploadMedia = jest.fn();
}

const outbound: OutboundMessage = {
  channelAccountId: ACCOUNT_ID,
  recipientExternalId: '919876543210',
  content: { type: MessageContentType.TEXT, text: 'hello' },
};

describe('ChannelAdapterService — defensive branches', () => {
  let service: ChannelAdapterService;
  let adapter: StubAdapter;
  let emit: jest.Mock;
  let webhookCreate: jest.Mock;

  beforeEach(async () => {
    emit = jest.fn();
    const prisma = makeMockPrisma();
    webhookCreate = prisma.webhookCreate;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelAdapterService,
        { provide: EventEmitter2, useValue: { emit } },
        { provide: PrismaService, useValue: prisma.service },
      ],
    }).compile();

    service = module.get(ChannelAdapterService);
    adapter = new StubAdapter();
    service.registerAdapter(adapter);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Inbound parse failures ──

  describe('when the adapter cannot parse the payload', () => {
    const req = { headers: {}, body: {}, rawBody: Buffer.from('{}') } as RawRequest;

    it('answers 400 with the parser reason, and does not emit message.received', async () => {
      adapter.parseInbound.mockImplementation(() => {
        throw new Error('unsupported message type: sticker');
      });

      await expect(
        service.handleInboundWebhook(ChannelType.SMS, req, BUSINESS_ID),
      ).rejects.toThrow(
        new BadRequestException(
          'Could not parse inbound message: unsupported message type: sticker',
        ),
      );
      expect(emit).not.toHaveBeenCalled();
    });

    it('stringifies a non-Error throw instead of reporting "undefined"', async () => {
      // A parser written with `throw 'reason'` (or a rejected string from a
      // third-party lib) has no `.message`; the reason has to survive anyway,
      // because it is the only thing in the 400 the channel sees.
      adapter.parseInbound.mockImplementation(() => {
        throw 'malformed envelope';
      });

      await expect(
        service.handleInboundWebhook(ChannelType.SMS, req, BUSINESS_ID),
      ).rejects.toThrow('Could not parse inbound message: malformed envelope');
    });
  });

  // ── Dedupe bookkeeping ──

  describe('webhook_events dedupe record', () => {
    it('stores an empty payload rather than null when the request has no body', async () => {
      // `payload` is non-nullable JSON in the schema — writing null there fails
      // the insert and every redelivery would then be reprocessed.
      await service.handleInboundWebhook(
        ChannelType.SMS,
        { headers: {}, body: undefined, rawBody: Buffer.from('') } as RawRequest,
        BUSINESS_ID,
      );

      expect(webhookCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ external_id: 'ext-1', payload: {} }),
        }),
      );
      expect(emit).toHaveBeenCalledWith('message.received', expect.anything());
    });

    it('logs a non-Error dedupe failure by stringifying it, and still processes', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      webhookCreate.mockRejectedValueOnce('pool exhausted');

      await service.handleInboundWebhook(
        ChannelType.SMS,
        { headers: {}, body: {}, rawBody: Buffer.from('{}') } as RawRequest,
        BUSINESS_ID,
      );

      expect(logged).toHaveBeenCalledWith(expect.stringContaining('pool exhausted'));
      // Dedupe is best-effort: losing the record must not lose the message.
      expect(emit).toHaveBeenCalledWith('message.received', expect.anything());
      logged.mockRestore();
    });
  });

  // ── Outbound result shapes ──

  describe('message.sent when the adapter reports success', () => {
    it('carries an empty external id when the channel returned none', async () => {
      // SMTP and some SMS gateways acknowledge without a per-message id;
      // `externalMessageId` is a required string on the event.
      adapter.sendMessage.mockResolvedValue({ success: true });

      await service.sendMessage(ChannelType.SMS, outbound, BUSINESS_ID);

      expect(emit).toHaveBeenCalledWith(
        'message.sent',
        expect.objectContaining({ type: 'message.sent', externalMessageId: '' }),
      );
    });
  });

  describe('message.failed when the adapter reports failure', () => {
    it('substitutes a reason and one attempt when the adapter gave neither', async () => {
      adapter.sendMessage.mockResolvedValue({ success: false });

      const result = await service.sendMessage(ChannelType.SMS, outbound, BUSINESS_ID);

      expect(result.success).toBe(false);
      expect(emit).toHaveBeenCalledWith(
        'message.failed',
        expect.objectContaining({
          type: 'message.failed',
          reason: 'Unknown error',
          attempts: 1,
        }),
      );
    });

    it('keeps the reason and attempt count the adapter supplied', async () => {
      adapter.sendMessage.mockResolvedValue({
        success: false,
        error: 'recipient blocked',
        attempts: 3,
      });

      await service.sendMessage(ChannelType.SMS, outbound, BUSINESS_ID);

      expect(emit).toHaveBeenCalledWith(
        'message.failed',
        expect.objectContaining({ reason: 'recipient blocked', attempts: 3 }),
      );
    });
  });
});
