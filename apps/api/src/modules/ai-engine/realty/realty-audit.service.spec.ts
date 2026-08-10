/**
 * RealtyAuditService unit tests.
 *
 * This is the compliance record for autonomous realty decisions — one
 * append-only `audit_logs` row per AI turn, per blueprint §16.3/§21. Two things
 * therefore matter and neither is obvious from the call site.
 *
 * The route mode is collapsed onto an `AuditAction` verb, and the mapping is
 * lossy on purpose: AUTO becomes CREATE because a message was actually sent,
 * while DRAFT and GUIDED both become UPDATE because nothing reached the
 * customer. Getting that backwards would make an autonomous send indistinguish-
 * able from a drafted one in the audit trail.
 *
 * And the write is best-effort: it runs alongside a customer reply that has
 * already gone out, so a logging failure must never surface to the caller.
 */

import { AuditAction } from '@gosumo/database';

import {
  RealtyAuditService,
  type RealtyAuditEntry,
} from './realty-audit.service';
import type { PrismaService } from '../../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-d000-000000000001';

function entry(overrides: Partial<RealtyAuditEntry> = {}): RealtyAuditEntry {
  return {
    businessId: BUSINESS_ID,
    leadId: LEAD_ID,
    conversationId: 'conv-1',
    routeMode: 'AUTO',
    intent: 'PRICE_INQUIRY',
    confidence: 92,
    responseText: 'The 2BHK is priced at ₹85L.',
    violations: [],
    actions: [],
    ...overrides,
  };
}

describe('RealtyAuditService', () => {
  let service: RealtyAuditService;
  let prisma: { audit_logs: { create: jest.Mock } };
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = { audit_logs: { create: jest.fn().mockResolvedValue({}) } };
    service = new RealtyAuditService(prisma as unknown as PrismaService);
    errorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function writtenRow(): Record<string, unknown> {
    return prisma.audit_logs.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
  }

  function snapshot(): Record<string, unknown> {
    return writtenRow().resource_after as Record<string, unknown>;
  }

  // ─────────────────────────────────────────────
  // The row
  // ─────────────────────────────────────────────

  describe('audit row', () => {
    it('attributes the decision to the AI actor on the right tenant', async () => {
      await service.record(entry());

      expect(writtenRow()).toMatchObject({
        business_id: BUSINESS_ID,
        actor_type: 'AI',
        resource_type: 'realty_lead',
        resource_id: LEAD_ID,
      });
    });

    it('only ever inserts, never updates', async () => {
      // audit_logs is append-only at the DB level; an UPDATE would be rejected
      // by the audit_logs_no_update rule at runtime.
      await service.record(entry());

      expect(Object.keys(prisma.audit_logs)).toEqual(['create']);
      expect(prisma.audit_logs.create).toHaveBeenCalledTimes(1);
    });

    it('records a decision with no lead attached', async () => {
      await service.record(entry({ leadId: undefined }));

      expect(writtenRow().resource_id).toBeNull();
    });

    it('treats an explicitly null lead as unattached', async () => {
      await service.record(entry({ leadId: null }));

      expect(writtenRow().resource_id).toBeNull();
    });

    it('carries the correlation id when one is supplied', async () => {
      await service.record(entry({ correlationId: 'corr-9' }));

      expect(writtenRow().request_id).toBe('corr-9');
    });

    it('falls back to a null correlation id', async () => {
      await service.record(entry());

      expect(writtenRow().request_id).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // Route mode → audit verb
  // ─────────────────────────────────────────────

  describe('route mode mapping', () => {
    async function actionFor(routeMode: string): Promise<unknown> {
      await service.record(entry({ routeMode }));
      return writtenRow().action;
    }

    it('records an escalation as ESCALATE', async () => {
      expect(await actionFor('ESCALATE')).toBe(AuditAction.ESCALATE);
    });

    it('records an autonomous send as CREATE, since a message went out', async () => {
      expect(await actionFor('AUTO')).toBe(AuditAction.CREATE);
    });

    it('records a draft as UPDATE, since nothing reached the customer', async () => {
      expect(await actionFor('DRAFT')).toBe(AuditAction.UPDATE);
    });

    it('records a guided reply as UPDATE', async () => {
      expect(await actionFor('GUIDED')).toBe(AuditAction.UPDATE);
    });

    it('falls back to UPDATE for an unrecognised route mode', async () => {
      expect(await actionFor('SOMETHING_NEW')).toBe(AuditAction.UPDATE);
    });
  });

  // ─────────────────────────────────────────────
  // Description
  // ─────────────────────────────────────────────

  describe('description', () => {
    it('states the route, intent and confidence', async () => {
      await service.record(
        entry({ routeMode: 'AUTO', intent: 'SITE_VISIT', confidence: 95 }),
      );

      expect(writtenRow().description).toBe(
        'Realty AI AUTO · SITE_VISIT · confidence 95',
      );
    });

    it('appends the guardrails that fired', async () => {
      await service.record(
        entry({
          routeMode: 'ESCALATE',
          intent: 'PRICE_INQUIRY',
          confidence: 20,
          violations: ['unverified_price', 'stale_availability'],
        }),
      );

      expect(writtenRow().description).toBe(
        'Realty AI ESCALATE · PRICE_INQUIRY · confidence 20 · guardrails: unverified_price, stale_availability',
      );
    });

    it('omits the guardrail clause when none fired', async () => {
      await service.record(entry({ violations: [] }));

      expect(writtenRow().description).not.toContain('guardrails');
    });

    it('omits the guardrail clause when violations are absent entirely', async () => {
      await service.record(entry({ violations: undefined }));

      expect(writtenRow().description).not.toContain('guardrails');
    });
  });

  // ─────────────────────────────────────────────
  // Snapshot
  // ─────────────────────────────────────────────

  describe('decision snapshot', () => {
    it('captures the full decision', async () => {
      await service.record(
        entry({
          routeMode: 'DRAFT',
          intent: 'AVAILABILITY',
          confidence: 78,
          responseText: 'Confirming availability.',
          violations: ['stale_availability'],
          actions: [{ type: 'ASK_SLOT' }],
          conversationId: 'conv-7',
        }),
      );

      expect(snapshot()).toEqual({
        routeMode: 'DRAFT',
        intent: 'AVAILABILITY',
        confidence: 78,
        responseText: 'Confirming availability.',
        violations: ['stale_availability'],
        actions: [{ type: 'ASK_SLOT' }],
        conversationId: 'conv-7',
      });
    });

    it('normalises an absent response text to null', async () => {
      await service.record(entry({ responseText: undefined }));

      expect(snapshot().responseText).toBeNull();
    });

    it('normalises an explicitly null response text', async () => {
      await service.record(entry({ responseText: null }));

      expect(snapshot().responseText).toBeNull();
    });

    it('normalises absent violations to an empty list', async () => {
      await service.record(entry({ violations: undefined }));

      expect(snapshot().violations).toEqual([]);
    });

    it('normalises absent actions to an empty list', async () => {
      await service.record(entry({ actions: undefined }));

      expect(snapshot().actions).toEqual([]);
    });

    it('normalises an absent conversation to null', async () => {
      await service.record(entry({ conversationId: undefined }));

      expect(snapshot().conversationId).toBeNull();
    });

    it('normalises an explicitly null conversation', async () => {
      await service.record(entry({ conversationId: null }));

      expect(snapshot().conversationId).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // Best-effort
  // ─────────────────────────────────────────────

  describe('best-effort logging', () => {
    it('never throws when the audit write fails', async () => {
      // The customer reply has already gone out; failing here would surface a
      // logging problem as a failed AI turn.
      prisma.audit_logs.create.mockRejectedValue(new Error('db down'));

      await expect(service.record(entry())).resolves.toBeUndefined();
    });

    it('logs the lead and the reason', async () => {
      prisma.audit_logs.create.mockRejectedValue(new Error('db down'));

      await service.record(entry());

      const message = errorSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain(LEAD_ID);
      expect(message).toContain('db down');
    });

    it('marks the lead as unknown when there was none', async () => {
      prisma.audit_logs.create.mockRejectedValue(new Error('db down'));

      await service.record(entry({ leadId: null }));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('for lead ?'),
      );
    });

    it('stringifies a non-Error failure', async () => {
      prisma.audit_logs.create.mockRejectedValue('connection reset');

      await service.record(entry());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection reset'),
      );
    });
  });
});
