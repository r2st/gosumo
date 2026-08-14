import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditAction, TeamMemberRole } from '@gosumo/database';
import { TeamController } from './team.controller';
import { TenantService } from './tenant.service';
import { PrismaService } from '../../common/services/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { TEAM_MEMBER_RESOURCE } from './tenant.constants';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { InviteMemberDto } from './dto/invite-member.dto';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';

function makeMember(overrides: Record<string, unknown> = {}) {
  return { id: MEMBER_ID, name: 'Staff Person', email: 'staff@example.com', role: 'STAFF', status: 'ACTIVE', avatar_url: null, last_active_at: null, created_at: new Date('2024-01-01'), ...overrides };
}

describe('TeamController', () => {
  let controller: TeamController;
  let audit: { record: jest.Mock };
  let tenantService: { getMembers: jest.Mock; inviteMember: jest.Mock; removeMember: jest.Mock };
  let prisma: {
    team_members: {
      update: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(async () => {
    tenantService = { getMembers: jest.fn(), inviteMember: jest.fn(), removeMember: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    prisma = {
      team_members: { update: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamController],
      providers: [
        { provide: TenantService, useValue: tenantService },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: audit },
      ],
    }).compile();

    controller = module.get<TeamController>(TeamController);
  });

  describe('listTeam', () => {
    it('should return members in paginated wrapper', async () => {
      tenantService.getMembers.mockResolvedValue([makeMember(), makeMember({ id: '33333333-3333-3333-3333-333333333333', name: 'Admin', role: 'ADMIN' })]);
      const result = await controller.listTeam(TENANT_ID, {});
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe('Staff Person');
      expect(result.data[0]!.role).toBe('STAFF');
      expect(result.pagination.total).toBe(2);
    });

    it('should return empty data when no members', async () => {
      tenantService.getMembers.mockResolvedValue([]);
      const result = await controller.listTeam(TENANT_ID, {});
      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('should handle null members gracefully', async () => {
      tenantService.getMembers.mockResolvedValue(null);
      const result = await controller.listTeam(TENANT_ID, {});
      expect(result.data).toEqual([]);
    });

    it('should derive name from email when name is null', async () => {
      tenantService.getMembers.mockResolvedValue([makeMember({ name: null, email: 'john@acme.com' })]);
      const result = await controller.listTeam(TENANT_ID, {});
      expect(result.data[0]!.name).toBe('john');
    });
  });

  describe('inviteMember', () => {
    it('should delegate to tenantService.inviteMember with user sub', async () => {
      const invited = makeMember({ status: 'INVITED' });
      tenantService.inviteMember.mockResolvedValue(invited);
      const user: AuthenticatedUser = { sub: 'owner-id-123', businessId: TENANT_ID, role: 'OWNER' };
      const dto = { email: 'new@example.com', name: 'New', role: 'STAFF' } as unknown as InviteMemberDto;
      const result = await controller.inviteMember(TENANT_ID, user, dto);
      expect(result).toEqual(invited);
      expect(tenantService.inviteMember).toHaveBeenCalledWith(TENANT_ID, dto, 'owner-id-123');
    });
  });

  describe('updateRole', () => {
    const OWNER_ID = '44444444-4444-4444-4444-444444444444';

    /** The acting user, as `@CurrentUser()` would supply them. */
    function actor(sub: string) {
      return { sub, businessId: TENANT_ID, role: 'OWNER' } satisfies AuthenticatedUser;
    }

    /** Queue up the actor lookup, then the demotion-target lookup. */
    function withLookups(actorRole: string | null, targetRole?: string) {
      prisma.team_members.findFirst
        .mockResolvedValueOnce(actorRole === null ? null : { id: OWNER_ID, role: actorRole })
        .mockResolvedValueOnce(targetRole === undefined ? null : { role: targetRole });
    }

    it('updates the role when an owner makes the change', async () => {
      withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
      prisma.team_members.update.mockResolvedValue({
        id: MEMBER_ID,
        role: TeamMemberRole.MANAGER,
        status: 'ACTIVE',
      });

      const result = await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
        role: TeamMemberRole.MANAGER,
      });

      expect(result.id).toBe(MEMBER_ID);
      expect(result.role).toBe(TeamMemberRole.MANAGER);
      expect(prisma.team_members.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, business_id: TENANT_ID },
        data: { role: TeamMemberRole.MANAGER },
      });
    });

    it('refuses a non-owner, so a member cannot promote themselves', async () => {
      // The route is reachable by any authenticated member of the tenant. If
      // the actor's own role is not checked, a STAFF user PATCHes their own id
      // and becomes OWNER.
      withLookups(TeamMemberRole.STAFF);

      await expect(
        controller.updateRole(TENANT_ID, actor(MEMBER_ID), MEMBER_ID, {
          role: TeamMemberRole.OWNER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.team_members.update).not.toHaveBeenCalled();
    });

    it('refuses when the actor is not a member of the tenant at all', async () => {
      withLookups(null);

      await expect(
        controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
          role: TeamMemberRole.MANAGER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.team_members.update).not.toHaveBeenCalled();
    });

    it('scopes the actor lookup to the calling tenant', async () => {
      // An owner of business A must not be recognised as an owner of B.
      withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
      prisma.team_members.update.mockResolvedValue({ id: MEMBER_ID, role: TeamMemberRole.STAFF });

      await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
        role: TeamMemberRole.STAFF,
      });

      expect(prisma.team_members.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: OWNER_ID, business_id: TENANT_ID }),
        }),
      );
    });

    it('refuses to demote the last remaining owner', async () => {
      // Demoting the only owner leaves nobody who can grant roles, invite
      // members, or manage billing — the business cannot recover on its own.
      withLookups(TeamMemberRole.OWNER, TeamMemberRole.OWNER);
      prisma.team_members.count.mockResolvedValue(1);

      await expect(
        controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
          role: TeamMemberRole.MANAGER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.team_members.update).not.toHaveBeenCalled();
    });

    it('allows demoting an owner while another owner remains', async () => {
      withLookups(TeamMemberRole.OWNER, TeamMemberRole.OWNER);
      prisma.team_members.count.mockResolvedValue(2);
      prisma.team_members.update.mockResolvedValue({ id: MEMBER_ID, role: TeamMemberRole.MANAGER });

      const result = await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
        role: TeamMemberRole.MANAGER,
      });

      expect(result.role).toBe(TeamMemberRole.MANAGER);
    });

    it('does not count owners when the change is a promotion to owner', async () => {
      // Promoting someone to OWNER can never reduce the owner count, so the
      // guard must not spend a query on it.
      withLookups(TeamMemberRole.OWNER);
      prisma.team_members.update.mockResolvedValue({ id: MEMBER_ID, role: TeamMemberRole.OWNER });

      await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
        role: TeamMemberRole.OWNER,
      });

      expect(prisma.team_members.count).not.toHaveBeenCalled();
    });

    /**
     * `team_members.role` is a single mutable column: the update overwrites the
     * only record that the member ever held a different role, and nothing
     * anywhere says who changed it. Granting OWNER hands over billing, data
     * export, and the ability to grant OWNER again — so this is the one change
     * in the product that most needs a trail, and had none.
     */
    describe('audit trail', () => {
      it('records the actor, the target and the before/after roles', async () => {
        withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
        prisma.team_members.update.mockResolvedValue({
          id: MEMBER_ID,
          role: TeamMemberRole.OWNER,
          status: 'ACTIVE',
        });

        await controller.updateRole(
          TENANT_ID,
          { ...actor(OWNER_ID), email: 'owner@example.com' },
          MEMBER_ID,
          { role: TeamMemberRole.OWNER },
        );

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            businessId: TENANT_ID,
            actorType: 'TEAM_MEMBER',
            actorId: OWNER_ID,
            actorEmail: 'owner@example.com',
            action: AuditAction.UPDATE,
            resourceType: TEAM_MEMBER_RESOURCE,
            resourceId: MEMBER_ID,
            before: { role: TeamMemberRole.STAFF },
            after: { role: TeamMemberRole.OWNER },
          }),
        );
      });

      it('captures the previous role by reading before the update', async () => {
        // Read-after-write would diff the new role against itself and record a
        // change from OWNER to OWNER — a trail that exists but says nothing.
        withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
        prisma.team_members.update.mockResolvedValue({
          id: MEMBER_ID,
          role: TeamMemberRole.MANAGER,
        });

        await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
          role: TeamMemberRole.MANAGER,
        });

        const entry = audit.record.mock.calls[0]![0] as {
          before: { role: string };
          after: { role: string };
        };
        expect(entry.before.role).toBe(TeamMemberRole.STAFF);
        expect(entry.after.role).toBe(TeamMemberRole.MANAGER);
      });

      it('records nothing when the change is rejected', async () => {
        // A row describing a change that did not happen is worse than none —
        // it reads as authoritative.
        withLookups(TeamMemberRole.STAFF);

        await expect(
          controller.updateRole(TENANT_ID, actor(MEMBER_ID), MEMBER_ID, {
            role: TeamMemberRole.OWNER,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(audit.record).not.toHaveBeenCalled();
      });

      it('records nothing when the last-owner guard rejects the demotion', async () => {
        withLookups(TeamMemberRole.OWNER, TeamMemberRole.OWNER);
        prisma.team_members.count.mockResolvedValue(1);

        await expect(
          controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
            role: TeamMemberRole.MANAGER,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(audit.record).not.toHaveBeenCalled();
      });

      it('records after the update commits, not before', async () => {
        // The audit row asserts that the change happened. Writing it first
        // would make a failed UPDATE look, in the trail, like a completed
        // promotion — and the trail is the thing anyone investigating trusts.
        const order: string[] = [];
        withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
        prisma.team_members.update.mockImplementation(async () => {
          order.push('update');
          return { id: MEMBER_ID, role: TeamMemberRole.MANAGER };
        });
        audit.record.mockImplementation(async () => {
          order.push('audit');
        });

        await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
          role: TeamMemberRole.MANAGER,
        });

        expect(order).toEqual(['update', 'audit']);
      });

      it('leans on the audit service never rejecting, and awaits it', async () => {
        // `AuditLogService.record` swallows its own failures (pinned in its own
        // spec), so awaiting it here cannot fail a committed change. Awaiting
        // rather than firing-and-forgetting is deliberate: an unawaited promise
        // rejecting after the response would be an unhandled rejection.
        withLookups(TeamMemberRole.OWNER, TeamMemberRole.STAFF);
        prisma.team_members.update.mockResolvedValue({
          id: MEMBER_ID,
          role: TeamMemberRole.MANAGER,
        });

        const result = await controller.updateRole(TENANT_ID, actor(OWNER_ID), MEMBER_ID, {
          role: TeamMemberRole.MANAGER,
        });

        expect(result.role).toBe(TeamMemberRole.MANAGER);
        expect(audit.record).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('removeMember', () => {
    it('should delegate to tenantService.removeMember', async () => {
      tenantService.removeMember.mockResolvedValue(undefined);
      const user: AuthenticatedUser = { sub: 'manager-id-1', businessId: TENANT_ID, role: 'MANAGER' };

      await controller.removeMember(TENANT_ID, user, MEMBER_ID);

      expect(tenantService.removeMember).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID, 'manager-id-1');
    });

    it('passes the acting user through so the service can rank them', async () => {
      // Dropping the third argument would silently disable the rank check in
      // the service — it treats a missing actor as a system call and skips it.
      tenantService.removeMember.mockResolvedValue(undefined);
      const user: AuthenticatedUser = { sub: 'manager-id-1', businessId: TENANT_ID, role: 'MANAGER' };

      await controller.removeMember(TENANT_ID, user, MEMBER_ID);

      expect(tenantService.removeMember.mock.calls[0]![2]).toBe('manager-id-1');
    });
  });
});
