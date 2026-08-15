/**
 * ContextLoaderService — what the model is allowed to read, and in what order.
 *
 * Two failures this pins, both of which produce a *plausible* transcript rather
 * than an obviously broken one, which is why neither would ever be reported:
 *
 *  - **Order.** Rows were sorted by `created_at`, which is when we wrote them,
 *    not when the customer sent them. A provider redelivers a webhook whenever
 *    our response was slow or non-200, so a message sent at 10:00 can be
 *    written at 10:04 — after the reply to the message sent at 10:02. The model
 *    then reads an exchange in which the answer precedes the question and
 *    reasons over it as the real sequence.
 *
 *  - **Content.** A blank text message is not a turn. It is stored, it shows in
 *    the operator's inbox, and the transcript loader drops it again — but in
 *    between it drove an intent classification and a generation, two billed LLM
 *    calls reasoning over an empty `<customer_message>`, and whatever the model
 *    invented from nothing was sent back to the customer.
 */

import { Test, TestingModule } from '@nestjs/testing';
import type { messages } from '@gosumo/database';
import { MessageContentType } from '@gosumo/shared';

import {
  ContextLoaderService,
  effectiveMessageTime,
  inSendOrder,
} from './context-loader.service';
import { PrismaService } from '../../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-e000-000000000001';

/** A message row, reduced to the fields ordering and text extraction read. */
function row(over: Partial<messages> & { id: string }): messages {
  return {
    direction: 'INBOUND',
    type: MessageContentType.TEXT,
    text_content: 'hello',
    content: { type: MessageContentType.TEXT, text: 'hello' },
    created_at: new Date('2026-08-01T10:00:00Z'),
    sent_at: null,
    metadata: {},
    ...over,
  } as unknown as messages;
}

describe('message ordering', () => {
  describe('effectiveMessageTime', () => {
    it('prefers the provider send time', () => {
      const at = effectiveMessageTime(
        row({
          id: 'a',
          sent_at: new Date('2026-08-01T09:56:00Z'),
          created_at: new Date('2026-08-01T10:00:00Z'),
        }),
      );
      expect(new Date(at).toISOString()).toBe('2026-08-01T09:56:00.000Z');
    });

    it('falls back to the write time, which must stay total', () => {
      // Null for every row written before `sent_at` was persisted, and for any
      // channel whose provider reports no time. Not a rare path.
      const at = effectiveMessageTime(
        row({ id: 'a', sent_at: null, created_at: new Date('2026-08-01T10:00:00Z') }),
      );
      expect(new Date(at).toISOString()).toBe('2026-08-01T10:00:00.000Z');
    });
  });

  describe('inSendOrder', () => {
    it('puts a late redelivery back where the customer sent it', () => {
      // Written third, sent first. This is the whole bug.
      const redelivered = row({
        id: 'question',
        sent_at: new Date('2026-08-01T10:00:00Z'),
        created_at: new Date('2026-08-01T10:04:00Z'),
      });
      const later = row({
        id: 'follow-up',
        sent_at: new Date('2026-08-01T10:02:00Z'),
        created_at: new Date('2026-08-01T10:02:00Z'),
      });
      const reply = row({
        id: 'reply',
        direction: 'OUTBOUND',
        sent_at: new Date('2026-08-01T10:03:00Z'),
        created_at: new Date('2026-08-01T10:03:00Z'),
      });

      expect(inSendOrder([reply, later, redelivered]).map((m) => m.id)).toEqual([
        'question',
        'follow-up',
        'reply',
      ]);
    });

    it('is stable across two loads when a burst shares one timestamp', () => {
      // Providers report whole seconds, so a burst of messages ties exactly.
      // Without the id tie-break their relative order varies per load and the
      // model sees a different conversation each time it is asked.
      const at = new Date('2026-08-01T10:00:00Z');
      const rows = [
        row({ id: 'c', sent_at: at }),
        row({ id: 'a', sent_at: at }),
        row({ id: 'b', sent_at: at }),
      ];
      expect(inSendOrder(rows).map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(inSendOrder([...rows].reverse()).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('orders a mix of timed and untimed rows without dropping either', () => {
      const rows = [
        row({ id: 'old', sent_at: null, created_at: new Date('2026-08-01T09:00:00Z') }),
        row({ id: 'new', sent_at: new Date('2026-08-01T11:00:00Z') }),
      ];
      expect(inSendOrder(rows).map((m) => m.id)).toEqual(['old', 'new']);
    });

    it('does not mutate the array it was handed', () => {
      const rows = [row({ id: 'b', sent_at: new Date(2) }), row({ id: 'a', sent_at: new Date(1) })];
      inSendOrder(rows);
      expect(rows.map((m) => m.id)).toEqual(['b', 'a']);
    });
  });
});

describe('ContextLoaderService', () => {
  let service: ContextLoaderService;
  let messagesDouble: { findMany: jest.Mock; findFirst: jest.Mock };

  beforeEach(async () => {
    messagesDouble = { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() };
    const prisma = {
      messages: messagesDouble,
      conversations: { findFirst: jest.fn().mockResolvedValue(null) },
      businesses: { findFirst: jest.fn().mockResolvedValue(null) },
      business_rules: { findMany: jest.fn().mockResolvedValue([]) },
      clients: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContextLoaderService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ContextLoaderService);
  });

  describe('loadTranscript', () => {
    it('renders the turns in send order, not write order', async () => {
      messagesDouble.findMany.mockResolvedValue([
        row({
          id: 'm3',
          text_content: 'and what is the price?',
          sent_at: new Date('2026-08-01T10:00:00Z'),
          created_at: new Date('2026-08-01T10:04:00Z'),
        }),
        row({
          id: 'm2',
          direction: 'OUTBOUND',
          text_content: 'Sure, one moment',
          sent_at: new Date('2026-08-01T10:03:00Z'),
          created_at: new Date('2026-08-01T10:03:00Z'),
        }),
        row({
          id: 'm1',
          text_content: 'hi there',
          sent_at: new Date('2026-08-01T09:59:00Z'),
          created_at: new Date('2026-08-01T09:59:00Z'),
        }),
      ]);

      const turns = await service.loadTranscript(BUSINESS_ID, CONVERSATION_ID);

      expect(turns.map((t) => t.text)).toEqual([
        'hi there',
        'and what is the price?',
        'Sure, one moment',
      ]);
    });

    it('still scopes the read to the business', async () => {
      await service.loadTranscript(BUSINESS_ID, CONVERSATION_ID);
      expect(messagesDouble.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ business_id: BUSINESS_ID }),
        }),
      );
    });

    it('degrades to an empty transcript when the read fails', async () => {
      messagesDouble.findMany.mockRejectedValue(new Error('pool exhausted'));
      await expect(service.loadTranscript(BUSINESS_ID, CONVERSATION_ID)).resolves.toEqual([]);
    });
  });

  describe('hasActionableContent', () => {
    it('rejects a text message that is only whitespace', async () => {
      messagesDouble.findFirst.mockResolvedValue(
        row({ id: 'm1', text_content: '   ', content: { type: 'TEXT', text: '   ' } }),
      );
      await expect(service.hasActionableContent(BUSINESS_ID, 'm1')).resolves.toBe(false);
    });

    it('rejects a text message that is one invisible character', async () => {
      // A zero-width space and a non-breaking space both trim away, and both
      // arrive from real keyboards and copy-paste.
      messagesDouble.findFirst.mockResolvedValue(
        row({ id: 'm1', text_content: '​ \n\t', content: { type: 'TEXT', text: ' ' } }),
      );
      await expect(service.hasActionableContent(BUSINESS_ID, 'm1')).resolves.toBe(false);
    });

    it('accepts a single emoji, which is a whole turn', async () => {
      messagesDouble.findFirst.mockResolvedValue(
        row({ id: 'm1', text_content: '👍', content: { type: 'TEXT', text: '👍' } }),
      );
      await expect(service.hasActionableContent(BUSINESS_ID, 'm1')).resolves.toBe(true);
    });

    it('accepts an image with no text — media is the reason this is not "is it empty"', async () => {
      messagesDouble.findFirst.mockResolvedValue(
        row({
          id: 'm1',
          type: MessageContentType.IMAGE,
          text_content: null,
          content: { type: 'IMAGE', mediaUrl: 'https://cdn.example.com/floorplan.jpg' },
        }),
      );
      await expect(service.hasActionableContent(BUSINESS_ID, 'm1')).resolves.toBe(true);
    });

    it('processes the message anyway when it cannot be read', async () => {
      // Refusing a turn because of a failed lookup is the costlier mistake.
      messagesDouble.findFirst.mockRejectedValue(new Error('pool exhausted'));
      await expect(service.hasActionableContent(BUSINESS_ID, 'm1')).resolves.toBe(true);
    });

    it('scopes the lookup to the business', async () => {
      messagesDouble.findFirst.mockResolvedValue(row({ id: 'm1' }));
      await service.hasActionableContent(BUSINESS_ID, 'm1');
      expect(messagesDouble.findFirst).toHaveBeenCalledWith({
        where: { id: 'm1', business_id: BUSINESS_ID },
      });
    });
  });

  describe('load', () => {
    it('exposes the sender address the reply is routed back to', async () => {
      // Null until the channel adapter began writing it, which is what made
      // `AiEngineService.deliver` bail on every message it handled.
      messagesDouble.findFirst.mockResolvedValue(
        row({ id: 'm1', metadata: { senderExternalId: '919876543210' } }),
      );
      const ctx = await service.load(BUSINESS_ID, CONVERSATION_ID, 'm1');
      expect(ctx.recipientExternalId).toBe('919876543210');
    });

    it('reports no recipient rather than a wrong one when the address is absent', async () => {
      messagesDouble.findFirst.mockResolvedValue(row({ id: 'm1', metadata: {} }));
      const ctx = await service.load(BUSINESS_ID, CONVERSATION_ID, 'm1');
      expect(ctx.recipientExternalId).toBeNull();
    });
  });
});
