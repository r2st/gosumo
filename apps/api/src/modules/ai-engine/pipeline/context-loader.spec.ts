/**
 * ContextLoaderService — the pipeline's Stage-2 read.
 *
 * The contract worth pinning down is the degradation behaviour: every
 * independent read is allowed to fail without failing the message. These tests
 * drive each read to both outcomes and check the text/recipient extraction
 * fallbacks that the prompt and the outbound delivery depend on.
 */
import { ChannelType, MessageContentType } from '@gosumo/shared';
import { ContextLoaderService } from './context-loader.service';
import { PrismaService } from '../../../common/services/prisma.service';
import { CONTEXT_MESSAGE_WINDOW } from '../ai-engine.constants';

const BUSINESS_ID = 'b1';
const CONVERSATION_ID = 'c1';
const MESSAGE_ID = 'm1';
const CLIENT_ID = 'cl1';

function makePrisma() {
  return {
    conversations: { findFirst: jest.fn().mockResolvedValue(null) },
    messages: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    businesses: { findFirst: jest.fn().mockResolvedValue(null) },
    business_rules: { findMany: jest.fn().mockResolvedValue([]) },
    clients: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new ContextLoaderService(prisma as unknown as PrismaService);
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    business_id: BUSINESS_ID,
    conversation_id: CONVERSATION_ID,
    text_content: null,
    content: null,
    metadata: null,
    channel_account_id: null,
    created_at: new Date('2026-06-27T00:00:00Z'),
    ...overrides,
  };
}

describe('ContextLoaderService', () => {
  it('loads every component and returns the history oldest-first', async () => {
    const prisma = makePrisma();
    prisma.conversations.findFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      client_id: CLIENT_ID,
      channel: ChannelType.WHATSAPP,
      channel_account_id: 'acc-1',
    });
    prisma.messages.findFirst.mockResolvedValue(
      message({
        text_content: 'kal 3 baje slot hai?',
        metadata: { senderExternalId: '919999900001' },
      }),
    );
    prisma.messages.findMany.mockResolvedValue([
      message({ id: 'm-newest', created_at: new Date('2026-06-27T00:02:00Z') }),
      message({ id: 'm-oldest', created_at: new Date('2026-06-27T00:01:00Z') }),
    ]);
    prisma.businesses.findFirst.mockResolvedValue({ id: BUSINESS_ID, name: 'Priya Salon' });
    prisma.business_rules.findMany.mockResolvedValue([{ id: 'rule-1' }]);
    prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, name: 'Priya' });

    const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

    expect(ctx.messageText).toBe('kal 3 baje slot hai?');
    expect(ctx.channel).toBe(ChannelType.WHATSAPP);
    expect(ctx.channelAccountId).toBe('acc-1');
    expect(ctx.recipientExternalId).toBe('919999900001');
    expect(ctx.client).toEqual({ id: CLIENT_ID, name: 'Priya' });
    expect(ctx.businessRules).toHaveLength(1);
    expect(ctx.history.map((m) => m.id)).toEqual(['m-oldest', 'm-newest']);
  });

  it('scopes every read to the tenant and caps the history window', async () => {
    const prisma = makePrisma();
    prisma.conversations.findFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      client_id: CLIENT_ID,
      channel: ChannelType.WHATSAPP,
      channel_account_id: 'acc-1',
    });

    await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

    expect(prisma.conversations.findFirst).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, business_id: BUSINESS_ID },
    });
    expect(prisma.messages.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversation_id: CONVERSATION_ID, business_id: BUSINESS_ID },
        take: CONTEXT_MESSAGE_WINDOW,
      }),
    );
    expect(prisma.business_rules.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: BUSINESS_ID, is_active: true, deleted_at: null },
      }),
    );
    expect(prisma.clients.findFirst).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, business_id: BUSINESS_ID },
    });
  });

  it('degrades every failed read instead of throwing', async () => {
    const prisma = makePrisma();
    prisma.conversations.findFirst.mockRejectedValue(new Error('conversations down'));
    prisma.messages.findFirst.mockRejectedValue(new Error('messages down'));
    prisma.messages.findMany.mockRejectedValue(new Error('history down'));
    prisma.businesses.findFirst.mockRejectedValue(new Error('businesses down'));
    prisma.business_rules.findMany.mockRejectedValue(new Error('rules down'));

    const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

    expect(ctx).toEqual({
      conversation: null,
      triggerMessage: null,
      history: [],
      business: null,
      client: null,
      businessRules: [],
      messageText: '',
      channel: null,
      channelAccountId: null,
      recipientExternalId: null,
    });
    // A dead conversation read means no client lookup is even attempted.
    expect(prisma.clients.findFirst).not.toHaveBeenCalled();
  });

  it('degrades a failed client read to null', async () => {
    const prisma = makePrisma();
    prisma.conversations.findFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      client_id: CLIENT_ID,
      channel: ChannelType.WHATSAPP,
      channel_account_id: 'acc-1',
    });
    prisma.clients.findFirst.mockRejectedValue(new Error('clients down'));

    const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

    expect(ctx.client).toBeNull();
    expect(ctx.conversation).not.toBeNull();
  });

  it('skips the client read for an anonymous conversation', async () => {
    const prisma = makePrisma();
    prisma.conversations.findFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      client_id: null,
      channel: null,
      channel_account_id: null,
    });

    const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

    expect(prisma.clients.findFirst).not.toHaveBeenCalled();
    expect(ctx.client).toBeNull();
    expect(ctx.channel).toBeNull();
  });

  describe('message text extraction', () => {
    it('prefers the denormalized text_content column', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(
        message({ text_content: 'denormalized', content: { type: 'TEXT', text: 'payload' } }),
      );

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.messageText).toBe('denormalized');
    });

    it('falls back to a TEXT content payload', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(
        message({ content: { type: MessageContentType.TEXT, text: 'from payload' } }),
      );

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.messageText).toBe('from payload');
    });

    it('yields an empty string for a non-TEXT payload', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(
        message({ content: { type: MessageContentType.IMAGE, url: 'https://img/1.jpg' } }),
      );

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.messageText).toBe('');
    });

    it('yields an empty string when a TEXT payload has no string text', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(
        message({ content: { type: MessageContentType.TEXT, text: 42 } }),
      );

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.messageText).toBe('');
    });

    it('yields an empty string when content is null', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(message());

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.messageText).toBe('');
    });
  });

  describe('recipient + channel account resolution', () => {
    it('falls back to the message channel account when the conversation has none', async () => {
      const prisma = makePrisma();
      prisma.conversations.findFirst.mockResolvedValue({
        id: CONVERSATION_ID,
        client_id: null,
        channel: ChannelType.SMS,
        channel_account_id: null,
      });
      prisma.messages.findFirst.mockResolvedValue(message({ channel_account_id: 'acc-from-msg' }));

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.channelAccountId).toBe('acc-from-msg');
    });

    it('returns no recipient when metadata carries no sender address', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(message({ metadata: { waId: 919999900001 } }));

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.recipientExternalId).toBeNull();
    });

    it('returns no recipient when metadata is absent entirely', async () => {
      const prisma = makePrisma();
      prisma.messages.findFirst.mockResolvedValue(message({ metadata: null }));

      const ctx = await makeService(prisma).load(BUSINESS_ID, CONVERSATION_ID, MESSAGE_ID);

      expect(ctx.recipientExternalId).toBeNull();
    });
  });

  describe('loadTranscript', () => {
    it('returns the turns oldest to newest, scoped to the tenant', async () => {
      const prisma = makePrisma();
      // Prisma is asked for newest-first; the method reverses.
      prisma.messages.findMany.mockResolvedValue([
        message({ id: 'm2', text_content: 'second', direction: 'OUTBOUND' }),
        message({ id: 'm1', text_content: 'first', direction: 'INBOUND' }),
      ]);

      const turns = await makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID, 5);

      expect(turns).toEqual([
        { direction: 'INBOUND', text: 'first' },
        { direction: 'OUTBOUND', text: 'second' },
      ]);
      expect(prisma.messages.findMany).toHaveBeenCalledWith({
        where: { conversation_id: CONVERSATION_ID, business_id: BUSINESS_ID },
        orderBy: { created_at: 'desc' },
        take: 5,
      });
    });

    it('defaults the window to CONTEXT_MESSAGE_WINDOW', async () => {
      const prisma = makePrisma();

      await makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID);

      expect(prisma.messages.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: CONTEXT_MESSAGE_WINDOW }),
      );
    });

    it('reads text out of a TEXT content payload when text_content is empty', async () => {
      const prisma = makePrisma();
      prisma.messages.findMany.mockResolvedValue([
        message({
          text_content: null,
          content: { type: MessageContentType.TEXT, text: 'from payload' },
          direction: 'INBOUND',
        }),
      ]);

      const turns = await makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID);

      expect(turns).toEqual([{ direction: 'INBOUND', text: 'from payload' }]);
    });

    it('drops turns with no extractable text rather than rendering blank speakers', async () => {
      const prisma = makePrisma();
      prisma.messages.findMany.mockResolvedValue([
        message({ id: 'm2', text_content: '   ', direction: 'INBOUND' }),
        message({ id: 'm1', text_content: 'real', direction: 'INBOUND' }),
      ]);

      const turns = await makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID);

      expect(turns).toEqual([{ direction: 'INBOUND', text: 'real' }]);
    });

    it('treats anything that is not OUTBOUND as a buyer turn', async () => {
      const prisma = makePrisma();
      prisma.messages.findMany.mockResolvedValue([
        message({ text_content: 'note', direction: 'INTERNAL' }),
      ]);

      const turns = await makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID);

      expect(turns[0]!.direction).toBe('INBOUND');
    });

    it('degrades to an empty history when the read fails', async () => {
      const prisma = makePrisma();
      prisma.messages.findMany.mockRejectedValue(new Error('connection reset'));

      await expect(
        makeService(prisma).loadTranscript(BUSINESS_ID, CONVERSATION_ID),
      ).resolves.toEqual([]);
    });
  });
});
