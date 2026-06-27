import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingAssistantService } from './onboarding-assistant.service';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import { OnboardingStepId } from './onboarding.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';

function createMockLlm() {
  return { complete: jest.fn() };
}

describe('OnboardingAssistantService', () => {
  let service: OnboardingAssistantService;
  let llm: ReturnType<typeof createMockLlm>;

  beforeEach(async () => {
    llm = createMockLlm();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingAssistantService,
        { provide: LlmClientService, useValue: llm },
      ],
    }).compile();
    service = module.get(OnboardingAssistantService);
  });

  it('returns the LLM reply with step-specific suggested questions', async () => {
    llm.complete.mockResolvedValue({ text: 'Use E.164 format, e.g. +919876543210.' });

    const res = await service.chat(BUSINESS_ID, {
      message: 'What WhatsApp number format do I need?',
      step: OnboardingStepId.CHANNELS,
    });

    expect(res.source).toBe('ai');
    expect(res.reply).toContain('E.164');
    expect(res.suggestedQuestions).toContain('How do I get a Meta Business verification?');
  });

  it('grounds the system prompt in the current step knowledge', async () => {
    llm.complete.mockResolvedValue({ text: 'ok' });

    await service.chat(BUSINESS_ID, {
      message: 'help',
      step: OnboardingStepId.AI_CONFIG,
    });

    const callArg = llm.complete.mock.calls[0][0];
    expect(callArg.system).toContain('confidence');
    expect(callArg.system).toContain('Configure AI');
    expect(callArg.maxTokens).toBeGreaterThan(0);
  });

  it('folds prior history into the user prompt', async () => {
    llm.complete.mockResolvedValue({ text: 'ok' });

    await service.chat(BUSINESS_ID, {
      message: 'and after that?',
      step: OnboardingStepId.CHANNELS,
      history: [
        { role: 'user', content: 'How do I connect WhatsApp?' },
        { role: 'assistant', content: 'Connect via Meta Business.' },
      ],
    });

    const callArg = llm.complete.mock.calls[0][0];
    expect(callArg.user).toContain('How do I connect WhatsApp?');
    expect(callArg.user).toContain("Operator's question: and after that?");
  });

  it('falls back to static knowledge when the LLM is unavailable', async () => {
    llm.complete.mockRejectedValue(new LlmUnavailableError('no api key'));

    const res = await service.chat(BUSINESS_ID, {
      message: 'How do I get a Meta Business verification?',
      step: OnboardingStepId.CHANNELS,
    });

    expect(res.source).toBe('fallback');
    expect(res.reply).toContain('Meta Business verification');
    expect(res.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it('falls back when the LLM returns an empty reply', async () => {
    llm.complete.mockResolvedValue({ text: '   ' });

    const res = await service.chat(BUSINESS_ID, {
      message: 'hi',
      step: OnboardingStepId.WELCOME,
    });

    expect(res.source).toBe('fallback');
    expect(res.reply.length).toBeGreaterThan(0);
  });

  it('defaults to the WELCOME step when none is provided', async () => {
    llm.complete.mockResolvedValue({ text: 'ok' });

    const res = await service.chat(BUSINESS_ID, { message: 'where do I start?' });

    expect(res.source).toBe('ai');
    const callArg = llm.complete.mock.calls[0][0];
    expect(callArg.system).toContain('Welcome');
  });
});
