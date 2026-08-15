import type { MessageReceivedEvent } from '@gosumo/shared';
import { ContextLoaderService } from '../pipeline/context-loader.service';
import { ChannelAdapterService } from '../../channel-adapter/channel-adapter.service';
import { RealtyLeadsService, LeadResponseDto } from '../../realty-leads/realty-leads.service';
import { RealtyBrokerService } from '../../realty-broker/realty-broker.service';
import { RealtyTenantService } from './realty-tenant.service';
import { RealtyAiService, RealtyDecision } from './realty-ai.service';
import { RealtyMessageBridgeService } from './realty-message-bridge.service';
import { ConversationLockService } from '../../../common/services/conversation-lock.service';

// ─────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────

const PHONE = '+919876543210';

function makeEvent(over: Partial<MessageReceivedEvent> = {}): MessageReceivedEvent {
  return {
    id: 'evt-1',
    timestamp: '2026-07-03T10:00:00Z',
    businessId: 'biz-1',
    correlationId: 'corr-1',
    type: 'message.received',
    messageId: 'm1',
    conversationId: 'c1',
    channelAccountId: 'acc1',
    channel: 'WHATSAPP',
    senderExternalId: PHONE,
    senderPhone: PHONE,
    clientId: 'cl1',
    ...over,
  } as MessageReceivedEvent;
}

function makeLead(over: Partial<LeadResponseDto> = {}): LeadResponseDto {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    whatsappPhone: PHONE,
    languagePref: 'hi',
    conversationId: 'c1',
    optOut: false,
    ...over,
  } as unknown as LeadResponseDto;
}

function makeDecision(over: Partial<RealtyDecision> = {}): RealtyDecision {
  return {
    routeMode: 'AUTO',
    intent: 'PROPERTY_DISCOVERY' as RealtyDecision['intent'],
    responseText: 'Ji bilkul, main aapke liye 2BHK options dhoondta hoon.',
    confidence: {
      dataAvailability: 48,
      policyClarity: 46,
      finalScore: 94,
      mode: 'AUTO',
      overrides: [],
    },
    bltc: {} as RealtyDecision['bltc'],
    contradictions: [],
    nextQuestion: null,
    qualified: false,
    matchedUnitIds: [],
    guardViolations: [],
    escalationReason: null,
    correlationId: 'corr-1',
    ...over,
  } as RealtyDecision;
}

interface Harness {
  bridge: RealtyMessageBridgeService;
  isRealtyTenant: jest.Mock;
  load: jest.Mock;
  ensureLeadByPhone: jest.Mock;
  processTurn: jest.Mock;
  evaluateAutonomy: jest.Mock;
  createApproval: jest.Mock;
  sendMessage: jest.Mock;
}

function makeHarness(): Harness {
  const isRealtyTenant = jest.fn().mockResolvedValue(true);
  const load = jest.fn().mockResolvedValue({
    messageText: 'mujhe 2BHK chahiye Andheri mein',
    triggerMessage: { direction: 'INBOUND' },
  });
  const ensureLeadByPhone = jest.fn().mockResolvedValue(makeLead());
  const processTurn = jest.fn().mockResolvedValue(makeDecision());
  const evaluateAutonomy = jest.fn().mockResolvedValue({ autoSend: true, reason: 'confidence_ok' });
  const createApproval = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const sendMessage = jest.fn().mockResolvedValue({ success: true });

  const bridge = new RealtyMessageBridgeService(
    { isRealtyTenant } as unknown as RealtyTenantService,
    { load } as unknown as ContextLoaderService,
    { ensureLeadByPhone } as unknown as RealtyLeadsService,
    { processTurn } as unknown as RealtyAiService,
    { evaluateAutonomy, createApproval } as unknown as RealtyBrokerService,
    { sendMessage } as unknown as ChannelAdapterService,
    new ConversationLockService(),
  );

  return {
    bridge,
    isRealtyTenant,
    load,
    ensureLeadByPhone,
    processTurn,
    evaluateAutonomy,
    createApproval,
    sendMessage,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('RealtyMessageBridgeService', () => {
  describe('tenant gating', () => {
    it('does nothing for a non-realty tenant (generic ai-engine owns it)', async () => {
      const h = makeHarness();
      h.isRealtyTenant.mockResolvedValue(false);

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.load).not.toHaveBeenCalled();
      expect(h.processTurn).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
    });

    it('skips when the conversation/message is not yet resolved', async () => {
      const h = makeHarness();
      await h.bridge.handleMessageReceived(makeEvent({ conversationId: '' as never }));
      expect(h.load).not.toHaveBeenCalled();
    });
  });

  describe('routing the turn', () => {
    it('resolves the lead by phone and runs the grounded turn with the message text', async () => {
      const h = makeHarness();

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.ensureLeadByPhone).toHaveBeenCalledWith(
        'biz-1',
        PHONE,
        expect.objectContaining({ conversationId: 'c1', clientId: 'cl1' }),
      );
      expect(h.processTurn).toHaveBeenCalledWith(
        'biz-1',
        expect.objectContaining({
          leadId: 'lead-1',
          messageText: 'mujhe 2BHK chahiye Andheri mein',
          conversationId: 'c1',
          correlationId: 'corr-1',
        }),
      );
    });

    it('passes a Hinglish message through verbatim (language handled in the loop)', async () => {
      const h = makeHarness();
      h.load.mockResolvedValue({
        messageText: 'bhai budget 1.2 Cr hai, ready possession chahiye',
        triggerMessage: { direction: 'INBOUND' },
      });

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.processTurn).toHaveBeenCalledWith(
        'biz-1',
        expect.objectContaining({ messageText: 'bhai budget 1.2 Cr hai, ready possession chahiye' }),
      );
    });

    it('ignores our own outbound echoes', async () => {
      const h = makeHarness();
      h.load.mockResolvedValue({
        messageText: 'auto reply',
        triggerMessage: { direction: 'OUTBOUND' },
      });

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.ensureLeadByPhone).not.toHaveBeenCalled();
      expect(h.processTurn).not.toHaveBeenCalled();
    });

    it('skips a message with no usable text (e.g. bare media)', async () => {
      const h = makeHarness();
      h.load.mockResolvedValue({ messageText: '   ', triggerMessage: { direction: 'INBOUND' } });

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.processTurn).not.toHaveBeenCalled();
    });

    it('skips when the phone cannot resolve a lead', async () => {
      const h = makeHarness();
      h.ensureLeadByPhone.mockResolvedValue(null);

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.processTurn).not.toHaveBeenCalled();
    });
  });

  describe('delivery by confidence band', () => {
    it('AUTO + autonomy allows → sends the reply on the originating channel', async () => {
      const h = makeHarness();

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.evaluateAutonomy).toHaveBeenCalledWith('biz-1', 94, 'c1');
      expect(h.sendMessage).toHaveBeenCalledWith(
        'WHATSAPP',
        expect.objectContaining({
          channelAccountId: 'acc1',
          recipientExternalId: PHONE,
          content: { type: 'TEXT', text: 'Ji bilkul, main aapke liye 2BHK options dhoondta hoon.' },
        }),
        'biz-1',
        'corr-1',
      );
      expect(h.createApproval).not.toHaveBeenCalled();
    });

    it('AUTO but the autonomy dial vetoes (kill switch / suggest / takeover) → queues a draft', async () => {
      const h = makeHarness();
      h.evaluateAutonomy.mockResolvedValue({ autoSend: false, reason: 'kill_switch' });

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.createApproval).toHaveBeenCalledWith(
        'biz-1',
        expect.objectContaining({ leadId: 'lead-1', draftText: expect.any(String), confidence: 94 }),
      );
    });

    it('DRAFT band (70–89) → queues a human draft, never auto-sends', async () => {
      const h = makeHarness();
      h.processTurn.mockResolvedValue(
        makeDecision({
          routeMode: 'DRAFT',
          confidence: { dataAvailability: 40, policyClarity: 40, finalScore: 80, mode: 'DRAFT', overrides: [] },
        }),
      );

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.evaluateAutonomy).not.toHaveBeenCalled();
      expect(h.createApproval).toHaveBeenCalledWith(
        'biz-1',
        expect.objectContaining({ confidence: 80, intent: 'PROPERTY_DISCOVERY' }),
      );
    });

    it('GUIDED band (50–69) → queues a human draft', async () => {
      const h = makeHarness();
      h.processTurn.mockResolvedValue(
        makeDecision({
          routeMode: 'GUIDED',
          confidence: { dataAvailability: 30, policyClarity: 30, finalScore: 60, mode: 'GUIDED', overrides: [] },
        }),
      );

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.createApproval).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).not.toHaveBeenCalled();
    });

    it('ESCALATE → sends nothing and queues nothing (human takes over)', async () => {
      const h = makeHarness();
      h.processTurn.mockResolvedValue(
        makeDecision({
          routeMode: 'ESCALATE',
          responseText: null,
          escalationReason: 'unverified_price',
          confidence: { dataAvailability: 10, policyClarity: 10, finalScore: 20, mode: 'ESCALATE', overrides: [] },
        }),
      );

      await h.bridge.handleMessageReceived(makeEvent());

      expect(h.sendMessage).not.toHaveBeenCalled();
      expect(h.createApproval).not.toHaveBeenCalled();
    });
  });

  describe('resilience', () => {
    it('never throws to the emitter when the turn fails', async () => {
      const h = makeHarness();
      h.processTurn.mockRejectedValue(new Error('LLM exploded'));

      await expect(h.bridge.handleMessageReceived(makeEvent())).resolves.toBeUndefined();
      expect(h.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────

  describe('two messages arriving back to back', () => {
    /**
     * `EventEmitter2.emit` does not await its listeners, so a buyer sending two
     * messages a second apart has two of these handlers in flight at once over
     * the same conversation. Both failures below are invisible in production:
     * nothing errors, the bot just answers in the wrong order and forgets a
     * fact the buyer already gave it.
     */
    it('does not start the second turn until the first has finished', async () => {
      // The BLTC merge is read → merge-in-memory → write. Overlapping turns both
      // read the same starting profile, each merges only its own message, and
      // the second write clobbers the first — the buyer states a budget and is
      // asked for it again on the next turn.
      const h = makeHarness();
      let inFlight = 0;
      let maxInFlight = 0;

      h.processTurn.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return makeDecision();
      });

      await Promise.all([
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm1' })),
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm2' })),
      ]);

      expect(h.processTurn).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(1);
    });

    it('replies in the order the messages arrived, not the order the LLM finished', async () => {
      const h = makeHarness();
      const sent: string[] = [];

      // The first turn is the slow one. Unserialized, its reply lands second.
      h.processTurn.mockImplementation(async (_biz: string, dto: { messageText: string }) => {
        const slow = dto.messageText === 'first';
        await new Promise((r) => setTimeout(r, slow ? 20 : 1));
        return makeDecision({ responseText: `reply:${dto.messageText}` });
      });
      h.load
        .mockResolvedValueOnce({ messageText: 'first', triggerMessage: { direction: 'INBOUND' } })
        .mockResolvedValueOnce({ messageText: 'second', triggerMessage: { direction: 'INBOUND' } });
      h.sendMessage.mockImplementation(async (_c: unknown, msg: { content: { text: string } }) => {
        sent.push(msg.content.text);
        return { success: true };
      });

      await Promise.all([
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm1' })),
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm2' })),
      ]);

      expect(sent).toEqual(['reply:first', 'reply:second']);
    });

    it('lets two different conversations run at once', async () => {
      // Serializing per tenant instead of per conversation would put every
      // buyer of a busy brokerage in one queue.
      const h = makeHarness();
      let inFlight = 0;
      let maxInFlight = 0;

      h.processTurn.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return makeDecision();
      });

      await Promise.all([
        h.bridge.handleMessageReceived(makeEvent({ conversationId: 'c1' })),
        h.bridge.handleMessageReceived(makeEvent({ conversationId: 'c2' })),
      ]);

      expect(maxInFlight).toBe(2);
    });

    it('hands the conversation to the next message after a failed turn', async () => {
      // A lock that stayed held on failure would wedge the buyer's conversation
      // for the life of the process.
      const h = makeHarness();
      h.processTurn
        .mockRejectedValueOnce(new Error('LLM exploded'))
        .mockResolvedValueOnce(makeDecision());

      await Promise.all([
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm1' })),
        h.bridge.handleMessageReceived(makeEvent({ messageId: 'm2' })),
      ]);

      expect(h.processTurn).toHaveBeenCalledTimes(2);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
