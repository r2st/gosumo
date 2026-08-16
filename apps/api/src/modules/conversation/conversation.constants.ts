/**
 * Conversation module constants.
 *
 * Centralizes tunable values referenced across the service, repository,
 * and tests so behaviour stays consistent and is documented in one place.
 */

/** Number of recent messages included in the AI context window. */
export const CONTEXT_WINDOW_SIZE = 20;

/** Maximum snooze duration. Snoozing beyond this is rejected. */
export const MAX_SNOOZE_DAYS = 7;
export const MAX_SNOOZE_MS = MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000;

/**
 * How many due-to-wake conversations the snooze-wake job claims per tick.
 * Each row is hydrated with the full conversation include, so the batch is
 * capped; a backlog drains across ticks rather than in one oversized read.
 */
export const SNOOZE_WAKE_BATCH_SIZE = 200;

/**
 * SLA targets (in seconds). Used to flag breaches in getSlaMetrics().
 * These mirror the defaults documented in the sprint plan; per-business
 * overrides would live in business_rules but are out of scope here.
 */
export const SLA_FIRST_RESPONSE_TARGET_SECONDS = 5 * 60; // 5 minutes
export const SLA_RESOLUTION_TARGET_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Sender types as stored on messages. Mirrors the `sender_type` VARCHAR
 * column convention used by the message module.
 */
export const SENDER_TYPE = {
  CLIENT: 'CLIENT',
  AI: 'AI',
  HUMAN_AGENT: 'HUMAN_AGENT',
  SYSTEM: 'SYSTEM',
} as const;

export type SenderType = (typeof SENDER_TYPE)[keyof typeof SENDER_TYPE];

/** Resolver categories carried on conversation.resolved events. */
export const RESOLVED_BY = {
  AI: 'AI',
  HUMAN: 'HUMAN',
  SYSTEM: 'SYSTEM',
} as const;

export type ResolvedBy = (typeof RESOLVED_BY)[keyof typeof RESOLVED_BY];

/** Auto-assignment strategies. */
export enum AutoAssignStrategy {
  /** Keep the conversation with the AI — unassigned, status OPEN. */
  AI = 'AI',
  /** Round-robin across the provided candidate agents. */
  ROUND_ROBIN = 'ROUND_ROBIN',
  /** Assign to the agent with the fewest active conversations. */
  LEAST_BUSY = 'LEAST_BUSY',
  /**
   * Assign to the least-busy agent holding every required skill.
   *
   * Skill match first, load second — the point is that only a qualified agent
   * is considered at all, and load balancing then decides between the ones who
   * are. Falls back to nothing rather than to an unqualified agent: routing a
   * Hindi conversation to someone who cannot read it is worse than leaving it
   * in the unassigned queue where a human will notice.
   */
  SKILL_BASED = 'SKILL_BASED',
}

/**
 * Task statuses that count as "open" when deciding whether a conversation
 * may be resolved. A conversation cannot be manually resolved while a task
 * in one of these states still references it.
 */
export const OPEN_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'ESCALATED'] as const;

/** Where the metadata internal note is stored on the conversation JSONB. */
export const INTERNAL_NOTE_KEY = 'internalNote';

/** Common escalation reasons surfaced on conversation.escalated events. */
export const ESCALATION_REASON = {
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
  NEGATIVE_SENTIMENT: 'NEGATIVE_SENTIMENT',
  POLICY_LIMIT: 'POLICY_LIMIT',
  LEGAL_THREAT: 'LEGAL_THREAT',
  MANUAL: 'MANUAL',
} as const;

export type EscalationReason =
  (typeof ESCALATION_REASON)[keyof typeof ESCALATION_REASON];

/**
 * Bull queue that carries the delayed snooze-wake job. Registered in
 * ConversationModule; consumed by ConversationProcessor.
 */
export const CONVERSATION_QUEUE = 'conversation';

export const CONVERSATION_JOBS = {
  /** Fires when a snoozed conversation's snooze window elapses. */
  SNOOZE_WAKE: 'snooze-wake',
} as const;

export interface SnoozeWakeJobData {
  businessId: string;
  conversationId: string;
}
