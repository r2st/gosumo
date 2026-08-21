/**
 * OperatorAlertListener unit tests.
 *
 * This is the listener `sla.escalated` never had, so the first case is simply
 * that the subscription exists — a decorator nobody asserts is a decorator that
 * can be deleted in a refactor and leave escalation silently reaching nobody
 * again, which is exactly how it got into that state.
 *
 * The rest pin the two properties the dedupe keys carry: repeats of the same
 * breach collapse, and the breach alert and its escalation do *not* collapse
 * into one another — they have different severities and different audiences on
 * purpose.
 */
import { Logger } from '@nestjs/common';
import type { SlaBreachedEvent, SlaEscalatedEvent } from '@gosumo/shared';

import { OperatorAlertListener } from './operator-alert.listener';
import { OperatorAlertService } from './operator-alert.service';
import { SLA_ALERT_KIND, SLA_ALERT_SEVERITY } from './operator-alert.constants';

const EVENT_METADATA = 'EVENT_LISTENER_METADATA';
const BIZ = '00000000-0000-4000-a000-000000000001';
const CONV = '00000000-0000-4000-c000-000000000001';
const POLICY = '00000000-0000-4000-d000-000000000001';

const breached = (over: Partial<SlaBreachedEvent> = {}): SlaBreachedEvent =>
  ({
    id: 'e1',
    type: 'sla.breached',
    timestamp: '2026-08-21T10:00:00.000Z',
    businessId: BIZ,
    correlationId: 'c1',
    conversationId: CONV,
    policyId: POLICY,
    breachType: 'FIRST_RESPONSE',
    targetMinutes: 15,
    actualMinutes: 42,
    ...over,
  }) as SlaBreachedEvent;

const escalated = (over: Partial<SlaEscalatedEvent> = {}): SlaEscalatedEvent =>
  ({
    id: 'e2',
    type: 'sla.escalated',
    timestamp: '2026-08-21T10:00:00.000Z',
    businessId: BIZ,
    correlationId: 'c1',
    conversationId: CONV,
    policyId: POLICY,
    breachType: 'RESOLUTION',
    action: 'NOTIFY',
    ...over,
  }) as SlaEscalatedEvent;

describe('OperatorAlertListener', () => {
  let alerts: { raise: jest.Mock };
  let listener: OperatorAlertListener;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    alerts = { raise: jest.fn().mockResolvedValue(null) };
    listener = new OperatorAlertListener(alerts as unknown as OperatorAlertService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('subscriptions', () => {
    it('subscribes to sla.breached', () => {
      expect(
        Reflect.getMetadata(EVENT_METADATA, OperatorAlertListener.prototype.handleBreached),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'sla.breached' })]));
    });

    it('subscribes to sla.escalated', () => {
      expect(
        Reflect.getMetadata(EVENT_METADATA, OperatorAlertListener.prototype.handleEscalated),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'sla.escalated' })]));
    });
  });

  describe('sla.breached', () => {
    it('raises a WARNING alert carrying the conversation and policy', async () => {
      await listener.handleBreached(breached());

      expect(alerts.raise).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({
          kind: SLA_ALERT_KIND.breach,
          severity: SLA_ALERT_SEVERITY.breach,
          conversationId: CONV,
          entityId: POLICY,
          dedupeKey: `sla.breached:${CONV}:FIRST_RESPONSE`,
        }),
      );
    });

    it('states how far past the target the conversation ran', async () => {
      await listener.handleBreached(breached({ targetMinutes: 15, actualMinutes: 42 }));

      const input = alerts.raise.mock.calls[0][1];
      expect(input.body).toContain('15 minute(s)');
      expect(input.body).toContain('27 minute(s)');
    });

    it('never reports a negative overrun when the clock disagrees', async () => {
      await listener.handleBreached(breached({ targetMinutes: 60, actualMinutes: 10 }));

      expect(alerts.raise.mock.calls[0][1].body).toContain('0 minute(s)');
    });

    it('swallows a malformed event rather than failing the emitter', async () => {
      await expect(
        listener.handleBreached(undefined as unknown as SlaBreachedEvent),
      ).resolves.toBeUndefined();
      expect(alerts.raise).not.toHaveBeenCalled();
    });
  });

  describe('sla.escalated', () => {
    it('raises a CRITICAL alert aimed at the action target', async () => {
      await listener.handleEscalated(escalated({ target: 'member-7' }));

      expect(alerts.raise).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({
          kind: SLA_ALERT_KIND.escalation,
          severity: SLA_ALERT_SEVERITY.escalation,
          target: 'member-7',
          dedupeKey: `sla.escalated:${CONV}:RESOLUTION:NOTIFY`,
        }),
      );
    });

    it('keys each action separately, so a two-action policy raises two alerts', async () => {
      await listener.handleEscalated(escalated({ action: 'NOTIFY' }));
      await listener.handleEscalated(escalated({ action: 'CREATE_TASK' }));

      const keys = alerts.raise.mock.calls.map((c: unknown[]) => (c[1] as { dedupeKey: string }).dedupeKey);
      expect(new Set(keys).size).toBe(2);
    });

    it('does not share a dedupe key with the breach alert for the same conversation', async () => {
      await listener.handleBreached(breached({ breachType: 'RESOLUTION' }));
      await listener.handleEscalated(escalated({ action: 'NOTIFY' }));

      const [first, second] = alerts.raise.mock.calls.map(
        (c: unknown[]) => (c[1] as { dedupeKey: string }).dedupeKey,
      );
      expect(first).not.toEqual(second);
    });

    it('says in words what the policy asked for, so an operator can do it', async () => {
      await listener.handleEscalated(escalated({ action: 'REASSIGN', target: 'MANAGER' }));

      const input = alerts.raise.mock.calls[0][1];
      expect(input.body).toContain('reassign');
      expect(input.body).toContain('MANAGER');
    });

    it('omits the target line when the action names nobody', async () => {
      await listener.handleEscalated(escalated({ target: undefined }));

      expect(alerts.raise.mock.calls[0][1].body).not.toContain('Target:');
      expect(alerts.raise.mock.calls[0][1].target).toBeNull();
    });

    it('swallows a malformed event rather than failing the emitter', async () => {
      await expect(
        listener.handleEscalated(undefined as unknown as SlaEscalatedEvent),
      ).resolves.toBeUndefined();
    });
  });
});
