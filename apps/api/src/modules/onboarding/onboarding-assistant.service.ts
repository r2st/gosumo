import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import {
  OnboardingStepId,
  ONBOARDING_STEPS,
  ONBOARDING_KNOWLEDGE,
  ONBOARDING_SUGGESTED_QUESTIONS,
  ONBOARDING_ASSISTANT_MAX_TOKENS,
  ONBOARDING_ASSISTANT_TEMPERATURE,
} from './onboarding.constants';
import { OnboardingChatDto, OnboardingChatResponse } from './dto';

/** Max prior turns folded into the prompt for context. */
const HISTORY_WINDOW = 6;

/**
 * OnboardingAssistantService — the AI helper that answers operator questions
 * during onboarding (e.g. "What WhatsApp number format do I need?").
 *
 * It reuses the project's existing Claude integration (`LlmClientService`) and
 * grounds answers in {@link ONBOARDING_KNOWLEDGE} for the current step. When the
 * LLM is unavailable (no API key, timeout, error) it degrades gracefully to a
 * deterministic answer built from the same knowledge base, so the assistant is
 * always useful — including in local dev without credentials.
 */
@Injectable()
export class OnboardingAssistantService {
  private readonly logger = new Logger(OnboardingAssistantService.name);

  constructor(private readonly llm: LlmClientService) {}

  async chat(businessId: string, dto: OnboardingChatDto): Promise<OnboardingChatResponse> {
    const step = dto.step ?? OnboardingStepId.WELCOME;
    const suggestedQuestions = ONBOARDING_SUGGESTED_QUESTIONS[step] ?? [];

    const system = this.buildSystemPrompt(step);
    const user = this.buildUserPrompt(dto);

    try {
      const completion = await this.llm.complete({
        system,
        user,
        maxTokens: ONBOARDING_ASSISTANT_MAX_TOKENS,
        temperature: ONBOARDING_ASSISTANT_TEMPERATURE,
      });
      const reply = completion.text.trim();
      if (!reply) {
        return this.fallback(step, suggestedQuestions);
      }
      return { reply, suggestedQuestions, source: 'ai' };
    } catch (err) {
      this.logger.warn(
        `Onboarding assistant LLM unavailable, using fallback for ${businessId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.fallback(step, suggestedQuestions);
    }
  }

  // ─────────────────────────────────────────────
  // Prompt construction
  // ─────────────────────────────────────────────

  private buildSystemPrompt(step: OnboardingStepId): string {
    const def = ONBOARDING_STEPS[step];
    const knowledge = ONBOARDING_KNOWLEDGE[step];
    return [
      'You are the GoSumo onboarding assistant. GoSumo is an AI-powered client',
      'management platform for small businesses in India that handles customer',
      'conversations across WhatsApp, Instagram, SMS, WebChat and Email.',
      '',
      `The operator is currently on the onboarding step "${def.title}": ${def.description}`,
      '',
      'Use ONLY the following facts to answer. If the answer is not covered, say',
      'you are not sure and suggest they check the relevant settings page or',
      "support docs — never invent product behaviour, prices, or steps that aren't listed.",
      '',
      'KNOWLEDGE:',
      knowledge,
      '',
      'Answer concisely (2-5 sentences), in a friendly, practical tone. Use plain',
      'language suitable for a non-technical small-business owner.',
    ].join('\n');
  }

  private buildUserPrompt(dto: OnboardingChatDto): string {
    const history = (dto.history ?? []).slice(-HISTORY_WINDOW);
    const lines: string[] = [];
    if (history.length > 0) {
      lines.push('Conversation so far:');
      for (const turn of history) {
        const who = turn.role === 'assistant' ? 'Assistant' : 'Operator';
        lines.push(`${who}: ${turn.content}`);
      }
      lines.push('');
    }
    lines.push(`Operator's question: ${dto.message}`);
    return lines.join('\n');
  }

  private fallback(
    step: OnboardingStepId,
    suggestedQuestions: string[],
  ): OnboardingChatResponse {
    const def = ONBOARDING_STEPS[step];
    const reply = [
      `Here's what helps with "${def.title}":`,
      '',
      ONBOARDING_KNOWLEDGE[step],
    ].join('\n');
    return { reply, suggestedQuestions, source: 'fallback' };
  }
}
