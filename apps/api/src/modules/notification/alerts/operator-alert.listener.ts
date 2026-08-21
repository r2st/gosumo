import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { SlaBreachedEvent, SlaEscalatedEvent } from '@gosumo/shared';

import { OperatorAlertService } from './operator-alert.service';
import {
  SLA_ALERT_ENTITY_TYPE,
  SLA_ALERT_KIND,
  SLA_ALERT_SEVERITY,
} from './operator-alert.constants';

/** How a breach type reads in an alert title. */
const BREACH_LABEL: Readonly<Record<string, string>> = {
  FIRST_RESPONSE: 'first-response',
  RESOLUTION: 'resolution',
};

/** What each escalation action asked for, in words an operator can act on. */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  NOTIFY: 'notify',
  REASSIGN: 'reassign',
  CREATE_TASK: 'create a task',
};

/**
 * OperatorAlertListener — turns SLA domain events into operator alerts.
 *
 * This is the listener `sla.escalated` never had. The SLA module detected
 * breaches, emitted one `sla.escalated` per configured escalation action, and
 * nothing subscribed: escalation was a log line. Both events are handled here
 * rather than in the SLA module because the alert *rules* (quiet hours, muting,
 * severity floor) belong to the notification module, and duplicating the
 * routing decision next to every emitter is exactly how quiet hours end up
 * honoured by three callers and ignored by a fourth.
 *
 * Both events fire for the same breach, and they raise separate alerts on
 * purpose:
 *
 *  - `sla.breached` fires for *every* missed target, including on policies with
 *    no escalation actions configured. That is the common case, and before this
 *    listener it reached nobody at all.
 *  - `sla.escalated` fires only where the business wrote a rule saying this
 *    case needs a specific human. It is CRITICAL and it is aimed at that
 *    person, so it must be able to page through a severity floor the breach
 *    alert does not clear.
 *
 * Their dedupe keys share the conversation and breach type but differ by
 * action, so repeats of either collapse while the pair does not collapse into
 * one another.
 */
@Injectable()
export class OperatorAlertListener {
  private readonly logger = new Logger(OperatorAlertListener.name);

  constructor(private readonly alerts: OperatorAlertService) {}

  /**
   * A missed SLA target.
   *
   * `promisify` so a slow dispatch is awaited rather than becoming a floating
   * promise, and the whole body is guarded: `raise` already swallows its own
   * failures, and this catch covers a malformed event reaching the formatter.
   */
  @OnEvent('sla.breached', { async: true, promisify: true })
  async handleBreached(event: SlaBreachedEvent): Promise<void> {
    try {
      const label = BREACH_LABEL[event.breachType] ?? event.breachType;
      const over = Math.max(0, event.actualMinutes - event.targetMinutes);

      await this.alerts.raise(event.businessId, {
        kind: SLA_ALERT_KIND.breach,
        severity: SLA_ALERT_SEVERITY.breach,
        title: `SLA breached: ${label} target missed`,
        body:
          `A conversation missed its ${label} target of ${event.targetMinutes} minute(s) ` +
          `by ${over} minute(s).`,
        conversationId: event.conversationId,
        entityType: SLA_ALERT_ENTITY_TYPE,
        entityId: event.policyId,
        context: {
          policyId: event.policyId,
          breachType: event.breachType,
          targetMinutes: event.targetMinutes,
          actualMinutes: event.actualMinutes,
        },
        dedupeKey: `sla.breached:${event.conversationId}:${event.breachType}`,
      });
    } catch (err) {
      this.logger.error(
        `Could not alert on sla.breached for conversation ${event?.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * A breach that matched a configured escalation action.
   *
   * One alert per action, because the actions are independent rules and each
   * may name a different target. REASSIGN and CREATE_TASK are surfaced rather
   * than executed — the alert states what the policy asked for so a human can
   * do it, which is strictly better than the silent no-op these actions were.
   */
  @OnEvent('sla.escalated', { async: true, promisify: true })
  async handleEscalated(event: SlaEscalatedEvent): Promise<void> {
    try {
      const label = BREACH_LABEL[event.breachType] ?? event.breachType;
      const action = ACTION_LABEL[event.action] ?? event.action;
      const aimed = event.target ? ` Target: ${event.target}.` : '';

      await this.alerts.raise(event.businessId, {
        kind: SLA_ALERT_KIND.escalation,
        severity: SLA_ALERT_SEVERITY.escalation,
        title: `SLA escalation: ${label} breach needs a human`,
        body:
          `A ${label} SLA breach matched an escalation rule asking to ${action}.` +
          `${aimed} The conversation is still unhandled.`,
        conversationId: event.conversationId,
        entityType: SLA_ALERT_ENTITY_TYPE,
        entityId: event.policyId,
        context: {
          policyId: event.policyId,
          breachType: event.breachType,
          action: event.action,
        },
        // Includes the action: a policy with both NOTIFY and CREATE_TASK asks
        // for two different things and an operator needs to see both.
        dedupeKey: `sla.escalated:${event.conversationId}:${event.breachType}:${event.action}`,
        target: event.target ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Could not alert on sla.escalated for conversation ${event?.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
