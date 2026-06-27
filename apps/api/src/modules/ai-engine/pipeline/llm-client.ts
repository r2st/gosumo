import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
} from '../ai-engine.constants';

// ─────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────

export interface LLMCompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface LLMCompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  latencyMs: number;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

/**
 * LLMClientService wraps LLM API calls with retry and timeout logic.
 *
 * On startup it tries to load the Anthropic SDK dynamically. If the SDK is
 * not installed (MVP / test environments), calls fall back to a deterministic
 * mock that returns structured JSON matching the pipeline's expected shapes.
 */
@Injectable()
export class LLMClientService implements OnModuleInit {
  private readonly logger = new Logger(LLMClientService.name);

  private anthropicClient: unknown = null;
  private useMock = false;

  async onModuleInit(): Promise<void> {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.anthropicClient = new Anthropic();
      this.logger.log('Anthropic SDK loaded successfully');
    } catch {
      this.useMock = true;
      this.logger.warn('Anthropic SDK not available — using mock LLM client');
    }
  }

  /**
   * Run a completion against the configured LLM (or the mock fallback).
   * Includes retry logic (2 attempts, 1 s delay) and per-call timeout.
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    options?: LLMCompletionOptions,
  ): Promise<LLMCompletionResult> {
    const model = options?.model ?? DEFAULT_MODEL;
    const maxTokens = options?.maxTokens ?? LLM_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = options?.timeoutMs ?? LLM_TIMEOUT_MS;

    const fn = this.useMock
      ? () => this.callMock(systemPrompt, userPrompt, model)
      : () => this.callAnthropic(systemPrompt, userPrompt, model, maxTokens, temperature, timeoutMs);

    return this.executeWithRetry(fn, 2);
  }

  // ─────────────────────────────────────────────
  // Retry wrapper
  // ─────────────────────────────────────────────

  private async executeWithRetry(
    fn: () => Promise<LLMCompletionResult>,
    attempts: number,
  ): Promise<LLMCompletionResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await fn();

        this.logger.log(
          `LLM completion succeeded — model=${result.modelId} ` +
            `prompt=${result.promptTokens} completion=${result.completionTokens} ` +
            `latency=${result.latencyMs}ms`,
        );

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isLast = attempt === attempts;

        if (isLast) {
          this.logger.error(
            `LLM completion failed after ${attempt} attempt(s): ${lastError.message}`,
          );
        } else {
          this.logger.warn(
            `LLM completion attempt ${attempt} failed, retrying in 1 s: ${lastError.message}`,
          );
          await this.sleep(1000);
        }
      }
    }

    throw lastError ?? new Error('LLM completion failed after all retries');
  }

  // ─────────────────────────────────────────────
  // Anthropic SDK path
  // ─────────────────────────────────────────────

  private async callAnthropic(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    maxTokens: number,
    temperature: number,
    timeoutMs: number,
  ): Promise<LLMCompletionResult> {
    const client = this.anthropicClient as {
      messages: {
        create: (params: unknown) => Promise<{
          content: Array<{ text: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }>;
      };
    };

    const startMs = Date.now();

    const completionPromise = client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const response = await Promise.race([completionPromise, timeoutPromise]);
    const latencyMs = Date.now() - startMs;

    const text = (response.content ?? [])
      .filter((block): block is { text: string } => typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();

    return {
      text,
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      modelId: model,
      latencyMs,
    };
  }

  // ─────────────────────────────────────────────
  // Mock path (MVP / tests)
  // ─────────────────────────────────────────────

  private async callMock(
    systemPrompt: string,
    _userPrompt: string,
    model: string,
  ): Promise<LLMCompletionResult> {
    const startMs = Date.now();

    // Simulate a small processing delay.
    await this.sleep(50);

    const isClassification = systemPrompt.toLowerCase().includes('classify');

    const mockResponse = isClassification
      ? JSON.stringify({
          intent: 'GENERAL_INQUIRY',
          confidence: 0.75,
          entities: {},
          reasoning: 'Mock classification — no real LLM available',
          alternatives: [
            { intent: 'CHIT_CHAT', confidence: 0.15 },
            { intent: 'PRICING', confidence: 0.10 },
          ],
        })
      : JSON.stringify({
          responseText:
            'Thank you for reaching out! Let me look into this for you and get back shortly.',
          reasoning: 'Mock response — no real LLM available',
          suggestedActions: [],
          profileUpdates: {},
        });

    return {
      text: mockResponse,
      promptTokens: Math.ceil(systemPrompt.length / 4),
      completionTokens: Math.ceil(mockResponse.length / 4),
      modelId: `mock-${model}`,
      latencyMs: Date.now() - startMs,
    };
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
