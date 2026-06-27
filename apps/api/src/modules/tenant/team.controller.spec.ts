import { Test, TestingModule } from '@nestjs/testing';
import { TeamController } from './team.controller';
import { TenantService } from './tenant.service';
import { PrismaService } from '../../common/services/prisma.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';

function makeMember(overrides: Record<string, any> = {}) {
  return { id: MEMBER_ID, name: 'Staff Person', email: 'staff@example.com', role: 'STAFF', status: 'ACTIVE', avatar_url: null, last_active_at: null, created_at: new Date('2024-01-01'), ...overrides };
}

describe('TeamController', () => {
  let controller: TeamController;
  let tenantService: { getMembers: jest.Mock; inviteMember: jest.Mock; removeMember: jest.Mock };
  let prisma: { team_members: { update: jest.Mock } };

  beforeEach(async () => {
    tenantService = { getMembers: jest.fn(), inviteMember: jest.fn(), removeMember: jest.fn() };
    prisma = { team_members: { update: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamController],
      providers: [
        { provide: TenantService, useValue: tenantService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = module.get<TeamController>(TeamController);
  });

  describe('listTeam', () => {
    it('should return members in paginated wrapper', async () => {
      tenantService.getMembers.mockResolvedValue([makeMember(), makeMember({ id: '33333333-3333-3333-3333-333333333333', name: 'Admin', role: 'ADMIN' })]);
      const result = await controller.listTeam(TENANT_ID);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe('Staff Person');
      expect(result.data[0]!.role).toBe('STAFF');
      expect(result.pagination.total).toBe(2);
    });

    it('should return empty data when no members', async () => {
      tenantService.getMembers.mockResolvedValue([]);
      const result = await controller.listTeam(TENANT_ID);
      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });

    it('should handle null members gracefully', async () => {
      tenantService.getMembers.mockResolvedValue(null);
      const result = await controller.listTeam(TENANT_ID);
      expect(result.data).toEqual([]);
    });

    it('should derive name from email when name is null', async () => {
      tenantService.getMembers.mockResolvedValue([makeMember({ name: null, email: 'john@acme.com' })]);
      const result = await controller.listTeam(TENANT_ID);
      expect(result.data[0]!.name).toBe('john');
    });
  });

  describe('inviteMember', () => {
    it('should delegate to tenantService.inviteMember with user sub', async () => {
      const invited = makeMember({ status: 'INVITED' });
      tenantService.inviteMember.mockResolvedValue(invited);
      const user = { sub: 'owner-id-123' } as any;
      const dto = { email: 'new@example.com', name: 'New', role: 'STAFF' } as any;
      const result = await controller.inviteMember(TENANT_ID, user, dto);
      expect(result).toEqual(invited);
      expect(tenantService.inviteMember).toHaveBeenCalledWith(TENANT_ID, dto, 'owner-id-123');
    });
  });

  describe('updateRole', () => {
    it('should update role and return updated member', async () => {
      prisma.team_members.update.mockResolvedValue({ id: MEMBER_ID, role: 'ADMIN', status: 'ACTIVE' });
      const result = await controller.updateRole(TENANT_ID, MEMBER_ID, { role: 'ADMIN' });
      expect(result.id).toBe(MEMBER_ID);
      expect(result.role).toBe('ADMIN');
      expect(prisma.team_members.update).toHaveBeenCalledWith({
        where: { id: MEMBER_ID, business_id: TENANT_ID },
        data: { role: 'ADMIN' },
      });
    });
  });

  describe('removeMember', () => {
    it('should delegate to tenantService.removeMember', async () => {
      tenantService.removeMember.mockResolvedValue(undefined);
      await controller.removeMember(TENANT_ID, MEMBER_ID);
      expect(tenantService.removeMember).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID);
    });
  });
});
