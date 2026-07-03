import { Injectable } from '@nestjs/common';
import { RealtyIntent } from '@gosumo/shared';
import type {
  RealtyGroundedResponse,
  RealtyIntentValue,
  BltcExtraction,
  RealtyAction,
  LeadPurposeValue,
  FinancingStatusValue,
} from '@gosumo/shared';
import { LlmClientService } from '../pipeline/llm-client.service';

/** Raw snake_case shape the grounded LLM turn is instructed to return. */
interface RealtyLlmShape {
  response_text?: string | null;
  confidence?: number;
  intent?: string;
  bltc_updates?: Record<string, unknown>;
  stage_transition?: string | null;
  actions?: Array<{ type?: string; parameters?: Record<string, unknown> }>;
  escalation_reason?: string | null;
}

/**
 * RealtyResponseParserService — turns the grounded turn's raw text into a
 * strongly-typed {@link RealtyGroundedResponse}. Defensive: malformed JSON,
 * missing fields, and wrong types degrade to safe defaults rather than throwing.
 */
@Injectable()
export class RealtyResponseParserService {
  constructor(private readonly llm: LlmClientService) {}

  /** Returns null only when no JSON object can be recovered at all. */
  parse(rawText: string, fallbackIntent: RealtyIntent): RealtyGroundedResponse | null {
    const json = this.llm.extractJson<RealtyLlmShape>(rawText);
    if (!json) return null;

    return {
      responseText: typeof json.response_text === 'string' ? json.response_text : null,
      confidence: this.clampScore(json.confidence),
      intent: this.coerceIntent(json.intent, fallbackIntent),
      bltcUpdates: this.coerceBltc(json.bltc_updates),
      stageTransition: typeof json.stage_transition === 'string' ? json.stage_transition : null,
      actions: this.coerceActions(json.actions),
      escalationReason: typeof json.escalation_reason === 'string' ? json.escalation_reason : null,
    };
  }

  private clampScore(v: unknown): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private coerceIntent(value: unknown, fallback: RealtyIntent): RealtyIntentValue {
    if (typeof value === 'string' && Object.values(RealtyIntent).includes(value as RealtyIntent)) {
      return value as RealtyIntentValue;
    }
    return fallback as RealtyIntentValue;
  }

  private coerceBltc(value: unknown): BltcExtraction {
    if (!this.isObject(value)) return {};
    const out: BltcExtraction = {};
    if (typeof value.budgetMinPaise === 'number') out.budgetMinPaise = value.budgetMinPaise;
    if (typeof value.budgetMaxPaise === 'number') out.budgetMaxPaise = value.budgetMaxPaise;
    if (typeof value.timelineMonths === 'number') out.timelineMonths = value.timelineMonths;
    if (typeof value.config === 'string') out.config = value.config;
    if (Array.isArray(value.localities)) {
      out.localities = value.localities.filter((l): l is string => typeof l === 'string');
    }
    if (value.purpose === 'END_USE' || value.purpose === 'INVEST') {
      out.purpose = value.purpose as LeadPurposeValue;
    }
    if (
      value.financing === 'CASH' ||
      value.financing === 'PREAPPROVED' ||
      value.financing === 'NEEDS_LOAN'
    ) {
      out.financing = value.financing as FinancingStatusValue;
    }
    return out;
  }

  private coerceActions(value: RealtyLlmShape['actions']): RealtyAction[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((a) => a && typeof a.type === 'string')
      .map((a) => ({
        type: a.type as string,
        parameters: this.isObject(a.parameters) ? a.parameters : {},
      }));
  }

  private isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
}
