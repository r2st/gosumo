import { Injectable } from '@nestjs/common';
import { IntentType, MessageDirection } from '@gosumo/shared';
import { messages, business_rules } from '@gosumo/database';
import { EnrichedContext } from './context-loader.service';
import { buildSystemPrompt, buildUserPrompt, SystemPromptVars } from '../prompts/system.prompt';

/**
 * PromptAssemblerService — composes the final system + user prompts from the
 * enriched context, intent, and RAG block. It owns the formatting of each
 * `<…>` section so the prompt structure stays consistent across every call.
 */
@Injectable()
export class PromptAssemblerService {
  /** Build the system prompt for a response-generation call. */
  assembleSystemPrompt(
    context: EnrichedContext,
    intent: IntentType,
    ragContextSection: string,
    detectedLanguage: string,
  ): string {
    const profile = (context.business?.profile as Record<string, unknown> | null) ?? {};

    const vars: SystemPromptVars = {
      businessName: context.business?.name ?? 'this business',
      businessType: str(profile['businessType']) ?? 'local',
      businessCity: str(profile['city']) ?? 'your city',
      businessState: str(profile['state']) ?? '',
      primaryLanguage: str(profile['primaryLanguage']) ?? 'Hindi/English',
      workingHours: str(profile['workingHours']) ?? 'Not specified',
      brandVoice: str(profile['brandVoice']) ?? 'warm and personal, like a trusted local shop',
      serializedPolicies: this.serializePolicies(context.businessRules),
      clientProfileSection: this.buildClientProfileSection(context),
      conversationHistorySection: this.buildHistorySection(context.history),
      ragContextSection,
      intent,
      detectedLanguage,
    };

    return buildSystemPrompt(vars);
  }

  /** Build the fenced, untrusted user prompt. */
  assembleUserPrompt(messageText: string): string {
    return buildUserPrompt(messageText);
  }

  /** Serialize active business rules into a compact policy block. */
  serializePolicies(rules: business_rules[]): string {
    if (rules.length === 0) {
      return 'No explicit policies configured. Apply general best practices and escalate anything uncertain.';
    }
    return rules
      .slice(0, 5)
      .map((r) => {
        const detail = r.embedding_text ?? r.description ?? '';
        return `${r.type}: ${r.name}${detail ? ` — ${detail}` : ''}`;
      })
      .join('\n');
  }

  private buildClientProfileSection(context: EnrichedContext): string {
    const client = context.client;
    if (!client) {
      return 'This is a NEW contact with no prior history. Treat them warmly as a potential new customer.';
    }

    const lines = [
      `Name: ${client.name ?? 'Unknown'}`,
      `Total Orders: ${client.total_orders}`,
      `Total Spent: ₹${Number(client.total_spent ?? 0).toFixed(2)}`,
    ];
    if (client.last_interaction_at) {
      lines.push(`Last Interaction: ${client.last_interaction_at.toISOString().slice(0, 10)}`);
    }
    if (client.churn_risk !== null && client.churn_risk !== undefined) {
      lines.push(`Churn Risk: ${Number(client.churn_risk).toFixed(2)}`);
    }
    return lines.join('\n');
  }

  private buildHistorySection(history: messages[]): string {
    if (history.length === 0) return 'No prior messages in this conversation.';

    return history
      .map((m) => {
        const speaker = m.direction === MessageDirection.INBOUND ? 'Customer' : 'Agent';
        const text = m.text_content ?? this.contentPreview(m);
        return `[${speaker}] ${text}`;
      })
      .join('\n');
  }

  private contentPreview(message: messages): string {
    const content = message.content as Record<string, unknown> | null;
    if (!content) return '[no content]';
    if (typeof content['text'] === 'string') return content['text'];
    return `[${String(content['type'] ?? 'message')}]`;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
