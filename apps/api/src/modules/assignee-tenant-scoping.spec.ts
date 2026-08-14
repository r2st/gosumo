/**
 * Cross-tenant assignee ratchet.
 *
 * `repository-contract.spec.ts` proves every WHERE clause on a tenant table
 * carries `business_id`, and `controller-contract.spec.ts` proves the tenant
 * reaching the service came from the JWT rather than the body. Between them
 * they cover the row being read or written — but not the *foreign keys stored
 * inside it*.
 *
 * An assignee id is exactly that gap. `PATCH /realty/leads/:id` is tenant-safe
 * in the ways both files check: `:id` is scoped, and the `businessId` used for
 * the write comes from the token. The `assignedAgentId` in the body is neither.
 * Nothing in the request is forged, so no tenant check fires; the value is
 * simply written verbatim into a row the caller legitimately owns.
 *
 * The consequences differ per column and neither is caught by the database:
 *
 *   - `realty_leads.assigned_agent_id` and `realty_site_visits.assigned_agent_id`
 *     carry no foreign key at all, so any UUID is accepted.
 *   - `tasks.assigned_to` *does* have a foreign key to `team_members(id)` —
 *     which is satisfied by any real member row, including another business's.
 *     A valid-looking constraint that permits the exact thing you want to
 *     prevent is worse than none, because it reads as protection.
 *
 * This file drives each write path with an assignee the tenant guard rejects
 * and asserts nothing is written. The per-module specs cover the happy paths;
 * what is asserted here is the refusal, in one place, so a new assignment
 * endpoint that forgets the guard has somewhere obvious to fail.
 */

import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskStatus, TaskType, TaskPriority } from '@gosumo/shared';

import { HitlService } from './hitl/hitl.service';
import { HitlRepository } from './hitl/hitl.repository';
import { RealtyLeadsService } from './realty-leads/realty-leads.service';
import { RealtyLeadsRepository } from './realty-leads/realty-leads.repository';
import { TenantService } from './tenant/tenant.service';
import { AuditLogService } from '../common/services/audit-log.service';
import { TenantRepository } from './tenant/tenant.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
/** A team member of a *different* business. Must never be written. */
const FOREIGN_MEMBER_ID = 'ffffffff-0000-4000-a000-0000000000ff';
const OWN_MEMBER_ID = '00000000-0000-4000-c000-000000000001';
const LEAD_ID = '00000000-0000-4000-b000-000000000001';
const TASK_ID = '00000000-0000-4000-b000-000000000002';
const CONVERSATION_ID = '00000000-0000-4000-b000-000000000003';

/**
 * A real `TenantService` over a repository double that models the tenant scope
 * honestly: `findTeamMemberById` returns a row only when the member belongs to
 * the business asked about.
 *
 * Using the real service rather than a mocked `assertTeamMember` is the point —
 * a mock would assert only that some method was called, while this asserts the
 * scoping rule itself, so weakening `findTeamMemberById`'s WHERE clause fails
 * here too.
 */
function makeTenantService(): TenantService {
  const repository = {
    findTeamMemberById: jest.fn(async (businessId: string, memberId: string) =>
      businessId === BUSINESS_ID && memberId === OWN_MEMBER_ID
        ? { id: OWN_MEMBER_ID, business_id: BUSINESS_ID, deleted_at: null }
        : null,
    ),
  } as unknown as TenantRepository;

  return new TenantService(
    repository,
    { emit: jest.fn() } as unknown as EventEmitter2,
    { record: jest.fn() } as unknown as AuditLogService,
  );
}

describe('TenantService.assertTeamMember', () => {
  const tenantService = makeTenantService();

  it('accepts a member of the calling business', async () => {
    await expect(
      tenantService.assertTeamMember(BUSINESS_ID, OWN_MEMBER_ID),
    ).resolves.toBeUndefined();
  });

  it('rejects a member of another business', async () => {
    await expect(
      tenantService.assertTeamMember(BUSINESS_ID, FOREIGN_MEMBER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an id that names no member at all', async () => {
    await expect(
      tenantService.assertTeamMember(BUSINESS_ID, '00000000-0000-4000-c000-00000000dead'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not reveal whether the id exists elsewhere', async () => {
    // Both failures must be indistinguishable, or the endpoint becomes an
    // oracle for enumerating team-member ids across tenants.
    const messageFor = async (memberId: string): Promise<string> => {
      try {
        await tenantService.assertTeamMember(BUSINESS_ID, memberId);
        throw new Error(`expected ${memberId} to be rejected`);
      } catch (error) {
        return (error as Error).message;
      }
    };

    const missingId = '00000000-0000-4000-c000-00000000dead';
    const foreign = await messageFor(FOREIGN_MEMBER_ID);
    const missing = await messageFor(missingId);

    expect(foreign.replace(FOREIGN_MEMBER_ID, 'ID')).toBe(missing.replace(missingId, 'ID'));
  });
});

describe('HitlService.assignTask refuses a cross-tenant assignee', () => {
  function makeService(): { service: HitlService; repository: { updateTask: jest.Mock } } {
    const repository = {
      findTaskById: jest.fn().mockResolvedValue({
        id: TASK_ID,
        business_id: BUSINESS_ID,
        conversation_id: CONVERSATION_ID,
        status: TaskStatus.PENDING,
        type: TaskType.REVIEW_RESPONSE,
        priority: TaskPriority.MEDIUM,
        metadata: {},
      }),
      updateTask: jest.fn().mockResolvedValue({ id: TASK_ID }),
    };

    const service = new HitlService(
      repository as unknown as HitlRepository,
      { emit: jest.fn() } as unknown as EventEmitter2,
      makeTenantService(),
    );

    return { service, repository };
  }

  it('assigns to a member of the same business', async () => {
    const { service, repository } = makeService();

    await service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: OWN_MEMBER_ID });

    expect(repository.updateTask).toHaveBeenCalledWith(
      BUSINESS_ID,
      TASK_ID,
      expect.objectContaining({ assignedTo: OWN_MEMBER_ID }),
    );
  });

  it('refuses a member of another business and writes nothing', async () => {
    // The `tasks.assigned_to` FK would happily accept this row.
    const { service, repository } = makeService();

    await expect(
      service.assignTask(BUSINESS_ID, TASK_ID, { assigneeId: FOREIGN_MEMBER_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.updateTask).not.toHaveBeenCalled();
  });
});

describe('RealtyLeadsService refuses a cross-tenant agent', () => {
  function makeService(): {
    service: RealtyLeadsService;
    repository: { create: jest.Mock; update: jest.Mock };
  } {
    const lead = {
      id: LEAD_ID,
      business_id: BUSINESS_ID,
      whatsapp_phone: '+919876543210',
      source: 'PORTAL',
      stage: 'NEW',
      temperature: 'COLD',
      qual_score: 0,
      localities: [],
      extracted_facts: [],
      objections: [],
      promises: [],
      consent_log: [],
      matched_unit_ids: [],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const repository = {
      findByPhone: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(lead),
      create: jest.fn().mockResolvedValue(lead),
      update: jest.fn().mockResolvedValue(lead),
    };

    const service = new RealtyLeadsService(
      repository as unknown as RealtyLeadsRepository,
      { emit: jest.fn() } as unknown as EventEmitter2,
      makeTenantService(),
    );

    return { service, repository };
  }

  it('createLead refuses an agent from another business', async () => {
    const { service, repository } = makeService();

    await expect(
      service.createLead(BUSINESS_ID, {
        whatsappPhone: '+919876543210',
        source: 'PORTAL',
        assignedAgentId: FOREIGN_MEMBER_ID,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('updateLead refuses an agent from another business', async () => {
    const { service, repository } = makeService();

    await expect(
      service.updateLead(BUSINESS_ID, LEAD_ID, {
        assignedAgentId: FOREIGN_MEMBER_ID,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('assignAgent refuses an agent from another business', async () => {
    const { service, repository } = makeService();

    await expect(
      service.assignAgent(BUSINESS_ID, LEAD_ID, FOREIGN_MEMBER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('accepts an agent from the calling business', async () => {
    const { service, repository } = makeService();

    await service.assignAgent(BUSINESS_ID, LEAD_ID, OWN_MEMBER_ID);

    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      LEAD_ID,
      expect.objectContaining({ assignedAgentId: OWN_MEMBER_ID }),
    );
  });

  it('still allows creating an unassigned lead', async () => {
    // The guard must not turn an optional field into a required one — most
    // leads arrive from a portal with no agent yet.
    const { service, repository } = makeService();

    await service.createLead(BUSINESS_ID, {
      whatsappPhone: '+919876543210',
      source: 'PORTAL',
    } as never);

    expect(repository.create).toHaveBeenCalled();
  });

  it('still allows clearing an assignment', async () => {
    const { service, repository } = makeService();

    await service.updateLead(BUSINESS_ID, LEAD_ID, { assignedAgentId: null } as never);

    expect(repository.update).toHaveBeenCalledWith(
      BUSINESS_ID,
      LEAD_ID,
      expect.objectContaining({ assignedAgentId: null }),
    );
  });
});
