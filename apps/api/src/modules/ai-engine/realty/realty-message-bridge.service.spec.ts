import type { MessageReceivedEvent } from '@gosumo/shared';
import { ContextLoaderService } from '../pipeline/context-loader.service';
import { ChannelAdapterService } from '../../channel-adapter/channel-adapter.service';
import { RealtyLeadsService, LeadResponseDto } from '../../realty-leads/realty-leads.service';
import { RealtyBrokerService } from '../../realty-broker/realty-broker.service';
import { RealtyTenantService } from './realty-tenant.service';
import { RealtyAiService, RealtyDecision } from './realty-ai.service';
import { RealtyMessageBridgeService } from './realty-message-bridge.service';

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
});
