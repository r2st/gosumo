import { Injectable, Logger } from '@nestjs/common';
import {
  JAILBREAK_PATTERNS,
  LEGAL_THREAT_PATTERNS,
  HUMAN_REQUEST_PATTERNS,
  PII_PATTERNS,
  LOOP_DETECTION_THRESHOLD,
  PiiPattern,
} from '../ai-engine.constants';

export interface PiiDetection {
  type: PiiPattern['type'];
}

export interface PiiResult {
  hasPii: boolean;
  detected: PiiDetection[];
  /** Text with every detected PII span replaced by `[REDACTED_<TYPE>]`. */
  redactedText: string;
}

/**
 * Snapshot of safety signals for a single inbound message. Consumed by the
 * confidence calculator (to apply hard overrides) and by the pipeline (to
 * decide whether to even call the LLM).
 */
export interface SafetySignals {
  jailbreakDetected: boolean;
  legalThreatDetected: boolean;
  humanRequested: boolean;
  pii: PiiResult;
  loopDetected: boolean;
}

/**
 * GuardrailsService — defensive checks applied to untrusted customer input.
 *
 * Every method is pure and synchronous so it can run in well under the
 * pipeline's latency budget and be exhaustively unit-tested. Detection here
 * is independent of (and redundant with) the prompt-level safety rules:
 * defence in depth.
 */
@Injectable()
export class GuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);

  /**
   * Heuristic prompt-injection / jailbreak detection. When this returns true
   * the pipeline must NOT send the message to the LLM.
   */
  detectJailbreak(text: string): boolean {
    if (!text) return false;
    return JAILBREAK_PATTERNS.some((p) => p.test(text));
  }

  /** Legal-threat detection (consumer court, police, lawyer, fraud, …). */
  detectLegalThreat(text: string): boolean {
    if (!text) return false;
    return LEGAL_THREAT_PATTERNS.some((p) => p.test(text));
  }

  /** Customer explicitly asked to talk to a human. */
  detectHumanRequest(text: string): boolean {
    if (!text) return false;
    return HUMAN_REQUEST_PATTERNS.some((p) => p.test(text));
  }

  /**
   * Detect and redact PII. The bank-account check is intentionally omitted
   * from the default bank because a bare 9–18 digit run produces too many
   * false positives without nearby "account" context.
   */
  detectAndRedactPii(text: string): PiiResult {
    if (!text) {
      return { hasPii: false, detected: [], redactedText: text };
    }

    const detected: PiiDetection[] = [];
    let redacted = text;

    for (const { type, pattern } of PII_PATTERNS) {
      // Use a global clone so we can replace every occurrence safely.
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      if (pattern.test(text)) {
        detected.push({ type });
        redacted = redacted.replace(globalPattern, `[REDACTED_${type}]`);
      }
    }

    return { hasPii: detected.length > 0, detected, redactedText: redacted };
  }

  /**
   * Detect a stalled conversation loop. A loop is the same classified intent
   * repeating across {@link LOOP_DETECTION_THRESHOLD}+ consecutive inbound
   * turns with no progress (no action executed in between).
   *
   * @param recentIntents Classified intents of recent INBOUND turns, oldest→newest.
   * @param actionsExecuted Whether any action was executed across those turns.
   */
  detectLoop(recentIntents: string[], actionsExecuted: boolean): boolean {
    if (actionsExecuted) return false;
    if (recentIntents.length < LOOP_DETECTION_THRESHOLD) return false;

    const window = recentIntents.slice(-LOOP_DETECTION_THRESHOLD);
    const first = window[0];
    if (!first) return false;
    return window.every((intent) => intent === first);
  }

  /**
   * Run the full guardrail suite over a message + conversation context.
   */
  evaluate(
    text: string,
    context: { recentIntents?: string[]; actionsExecuted?: boolean } = {},
  ): SafetySignals {
    const pii = this.detectAndRedactPii(text);
    const signals: SafetySignals = {
      jailbreakDetected: this.detectJailbreak(text),
      legalThreatDetected: this.detectLegalThreat(text),
      humanRequested: this.detectHumanRequest(text),
      pii,
      loopDetected: this.detectLoop(
        context.recentIntents ?? [],
        context.actionsExecuted ?? false,
      ),
    };

    if (signals.jailbreakDetected) {
      this.logger.warn('Jailbreak attempt detected — message will not be sent to the LLM');
    }
    if (signals.pii.hasPii) {
      this.logger.warn(
        `PII detected in inbound message: ${signals.pii.detected.map((d) => d.type).join(', ')}`,
      );
    }

    return signals;
  }
}
