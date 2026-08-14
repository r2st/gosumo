/**
 * AuditLogService unit tests.
 *
 * The service has exactly two obligations, and they pull against each other:
 *
 *  - **Write a faithful row.** The trail is only worth having if actor, action,
 *    resource and diff arrive intact, because `audit_logs` is append-only and
 *    nothing can go back and correct a row later.
 *  - **Never break its caller.** It is invoked after privileged operations have
 *    already committed. A throw here would turn "the role change was recorded
 *    badly" into "the role change appears to have failed", and callers would
 *    start wrapping it defensively or dropping it.
 *
 * So every failure mode is pinned individually, and the id-shaped fields are
 * pinned separately again: they are `@db.Uuid` columns with foreign keys, and a
 * non-UUID reaching them fails the whole INSERT — losing the entire record over
 * one bad field.
 */

import { AuditAction } from '@gosumo/database';
import { AuditLogService } from './audit-log.service';
import type { PrismaService } from './prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000002';
const ACTOR_ID = '00000000-0000-4000-a000-000000000003';

interface PrismaMock {
  audit_logs: { create: jest.Mock };
}

function makeService(): { service: AuditLogService; prisma: PrismaMock } {
  const prisma: PrismaMock = {
    audit_logs: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    service: new AuditLogService(prisma as unknown as PrismaService),
    prisma,
  };
}

/** The `data` payload of the single recorded INSERT. */
const written = (prisma: PrismaMock): Record<string, unknown> =>
  (prisma.audit_logs.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;

describe('AuditLogService.record', () => {
  it('writes actor, action, resource and diff', async () => {
    const { service, prisma } = makeService();

    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'TEAM_MEMBER',
      actorId: ACTOR_ID,
      actorEmail: 'owner@example.com',
      action: AuditAction.UPDATE,
      resourceType: 'team_member',
      resourceId: MEMBER_ID,
      before: { role: 'STAFF' },
      after: { role: 'OWNER' },
      description: 'Changed role',
    });

    expect(written(prisma)).toMatchObject({
      business_id: BUSINESS_ID,
      actor_type: 'TEAM_MEMBER',
      actor_id: ACTOR_ID,
      actor_email: 'owner@example.com',
      action: AuditAction.UPDATE,
      resource_type: 'team_member',
      resource_id: MEMBER_ID,
      resource_before: { role: 'STAFF' },
      resource_after: { role: 'OWNER' },
      description: 'Changed role',
    });
  });

  it('only ever inserts — the table forbids update and delete', async () => {
    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'SYSTEM',
      action: AuditAction.CREATE,
      resourceType: 'team_member',
    });

    expect(prisma.audit_logs.create).toHaveBeenCalledTimes(1);
    expect(Object.keys(prisma.audit_logs)).toEqual(['create']);
  });

  it('leaves the timestamp to the database', async () => {
    // `created_at` defaults to `now()` in Postgres. Supplying one from the API
    // process would record when the writer's clock said it happened, which is
    // exactly the value an attacker with API access would want to control.
    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'SYSTEM',
      action: AuditAction.CREATE,
      resourceType: 'team_member',
    });

    expect(written(prisma)).not.toHaveProperty('created_at');
  });

  it('nulls the optional string fields it was not given', async () => {
    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'SYSTEM',
      action: AuditAction.CREATE,
      resourceType: 'team_member',
    });

    expect(written(prisma)).toMatchObject({
      actor_id: null,
      actor_email: null,
      resource_id: null,
      request_id: null,
      ip_address: null,
      user_agent: null,
      description: null,
    });
  });

  it('omits absent snapshots rather than writing JSON null', async () => {
    // `undefined` leaves the column alone; `null` would be a stored JSON null,
    // which reads as "we looked and there was nothing" rather than "not
    // captured". A create has no before, a delete has no after.
    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'SYSTEM',
      action: AuditAction.CREATE,
      resourceType: 'team_member',
      after: { role: 'STAFF' },
    });

    expect(written(prisma)['resource_before']).toBeUndefined();
    expect(written(prisma)['resource_after']).toEqual({ role: 'STAFF' });
  });

  it('serialises Dates inside a snapshot instead of failing the insert', async () => {
    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'SYSTEM',
      action: AuditAction.UPDATE,
      resourceType: 'team_member',
      before: { invitedAt: new Date('2026-08-14T10:00:00.000Z') },
    });

    expect(written(prisma)['resource_before']).toEqual({
      invitedAt: '2026-08-14T10:00:00.000Z',
    });
  });

  it('drops an unserialisable snapshot but still writes the row', async () => {
    // Losing the diff is bad; losing the fact that a privileged action happened
    // is worse.
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const { service, prisma } = makeService();
    await service.record({
      businessId: BUSINESS_ID,
      actorType: 'TEAM_MEMBER',
      actorId: ACTOR_ID,
      action: AuditAction.UPDATE,
      resourceType: 'team_member',
      before: cyclic,
    });

    expect(prisma.audit_logs.create).toHaveBeenCalledTimes(1);
    expect(written(prisma)['resource_before']).toBeUndefined();
    expect(written(prisma)['actor_id']).toBe(ACTOR_ID);
  });

  describe('uuid-shaped columns', () => {
    it('nulls a non-uuid resource id rather than losing the record', async () => {
      const { service, prisma } = makeService();
      await service.record({
        businessId: BUSINESS_ID,
        actorType: 'SYSTEM',
        action: AuditAction.CREATE,
        resourceType: 'team_member',
        resourceId: 'not-a-uuid',
        description: 'kept',
      });

      expect(written(prisma)['resource_id']).toBeNull();
      expect(written(prisma)['description']).toBe('kept');
    });

    it('nulls a non-uuid actor id', async () => {
      const { service, prisma } = makeService();
      await service.record({
        businessId: BUSINESS_ID,
        actorType: 'API',
        actorId: 'service-account',
        action: AuditAction.CREATE,
        resourceType: 'team_member',
      });

      expect(written(prisma)['actor_id']).toBeNull();
    });

    it('accepts a uuid in either case', async () => {
      const { service, prisma } = makeService();
      await service.record({
        businessId: BUSINESS_ID,
        actorType: 'TEAM_MEMBER',
        actorId: ACTOR_ID.toUpperCase(),
        action: AuditAction.CREATE,
        resourceType: 'team_member',
      });

      expect(written(prisma)['actor_id']).toBe(ACTOR_ID.toUpperCase());
    });
  });

  describe('best effort', () => {
    it('swallows a write failure so the audited operation still succeeds', async () => {
      const { service, prisma } = makeService();
      prisma.audit_logs.create.mockRejectedValue(new Error('deadlock detected'));

      await expect(
        service.record({
          businessId: BUSINESS_ID,
          actorType: 'TEAM_MEMBER',
          actorId: ACTOR_ID,
          action: AuditAction.UPDATE,
          resourceType: 'team_member',
        }),
      ).resolves.toBeUndefined();
    });

    it('swallows a rejection that is not an Error', async () => {
      const { service, prisma } = makeService();
      prisma.audit_logs.create.mockRejectedValue('connection reset');

      await expect(
        service.record({
          businessId: BUSINESS_ID,
          actorType: 'SYSTEM',
          action: AuditAction.DELETE,
          resourceType: 'team_member',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
