/**
 * RealtyOperationsAuditService unit tests — Phase 7 hardening.
 *
 * Covers: field mapping onto audit_logs, HTTP-verb → AuditAction mapping,
 * UUID-only resource_id coercion, before/after JSON snapshotting, and the
 * best-effort guarantee (a DB failure is swallowed, never thrown).
 */

import { AuditAction } from '@gosumo/database';
import { RealtyOperationsAuditService } from './realty-operations-audit.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const LEAD = '00000000-0000-4000-a000-000000000010';

describe('RealtyOperationsAuditService', () => {
  let create: jest.Mock;
  let service: RealtyOperationsAuditService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ id: 'audit-1' });
    service = new RealtyOperationsAuditService({ audit_logs: { create } } as never);
  });

  it('maps a full entry onto an audit_logs INSERT', async () => {
    await service.record({
      businessId: BIZ,
      actorType: 'TEAM_MEMBER',
      actorId: LEAD,
      actorEmail: 'agent@broker.in',
      action: AuditAction.UPDATE,
      resourceType: 'realty_lead',
      resourceId: LEAD,
      before: { stage: 'NEW' },
      after: { stage: 'QUALIFIED' },
      requestId: 'corr-1',
      ipAddress: '1.2.3.4',
      userAgent: 'jest',
      description: 'PATCH /v1/realty/leads/x',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      business_id: BIZ,
      actor_type: 'TEAM_MEMBER',
      actor_id: LEAD,
      actor_email: 'agent@broker.in',
      action: AuditAction.UPDATE,
      resource_type: 'realty_lead',
      resource_id: LEAD,
      request_id: 'corr-1',
      ip_address: '1.2.3.4',
      user_agent: 'jest',
    });
    expect(data.resource_before).toEqual({ stage: 'NEW' });
    expect(data.resource_after).toEqual({ stage: 'QUALIFIED' });
  });

  it('coerces a non-UUID resource_id to null (column is @db.Uuid)', async () => {
    await service.record({
      businessId: BIZ,
      actorType: 'API',
      action: AuditAction.CREATE,
      resourceType: 'realty_ops',
      resourceId: 'not-a-uuid',
    });
    expect(create.mock.calls[0][0].data.resource_id).toBeNull();
  });

  it('omits before/after when not supplied', async () => {
    await service.record({
      businessId: BIZ,
      actorType: 'SYSTEM',
      action: AuditAction.DELETE,
      resourceType: 'realty_unit',
    });
    const data = create.mock.calls[0][0].data;
    expect(data.resource_before).toBeUndefined();
    expect(data.resource_after).toBeUndefined();
  });

  it('never throws when the audit write fails (best-effort)', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({
        businessId: BIZ,
        actorType: 'AI',
        action: AuditAction.CREATE,
        resourceType: 'realty_lead',
      }),
    ).resolves.toBeUndefined();
  });

  it('maps HTTP verbs to audit actions', () => {
    expect(RealtyOperationsAuditService.actionForMethod('POST')).toBe(AuditAction.CREATE);
    expect(RealtyOperationsAuditService.actionForMethod('put')).toBe(AuditAction.UPDATE);
    expect(RealtyOperationsAuditService.actionForMethod('PATCH')).toBe(AuditAction.UPDATE);
    expect(RealtyOperationsAuditService.actionForMethod('DELETE')).toBe(AuditAction.DELETE);
    expect(RealtyOperationsAuditService.actionForMethod('GET')).toBe(AuditAction.UPDATE);
  });
});
