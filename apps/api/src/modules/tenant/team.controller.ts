import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  Logger, HttpCode, HttpStatus, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { ListTeamQueryDto, DEFAULT_TEAM_PAGE_SIZE } from './dto/list-team-query.dto';
import { AuditAction, TeamMemberRole } from '@gosumo/database';
import { PrismaService } from '../../common/services/prisma.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { TEAM_MEMBER_RESOURCE } from './tenant.constants';
import { PlanLimit } from '../billing/plan.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('team')
@Controller('auth/team')
export class TeamController {
  private readonly logger = new Logger(TeamController.name);
  constructor(
    private readonly tenantService: TenantService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The acting user's role *as currently stored*, not as claimed by their JWT.
   *
   * Access tokens live 15 minutes, so a member demoted a moment ago still
   * presents a token asserting the old role. RolesGuard necessarily trusts
   * that claim — it only has the token — which is fine as a coarse gate but
   * not as the last word on who may hand out authority. Invite and remove get
   * the equivalent re-read inside TenantService, which both they and the
   * `/tenant/members` routes share; role changes are handled only here.
   *
   * @throws ForbiddenException when the caller is not a live member of this tenant.
   */
  private async requireActor(tenantId: string, userId: string): Promise<{ id: string; role: TeamMemberRole }> {
    const actor = await this.prisma.team_members.findFirst({
      where: { id: userId, business_id: tenantId, deleted_at: null },
      select: { id: true, role: true },
    });

    if (!actor) {
      throw new ForbiddenException('Acting user is not a member of this business');
    }

    return actor;
  }

  @Get()
  @ApiOperation({ summary: 'List team members' })
  @ApiResponse({ status: 200, description: 'Paginated team list for this business' })
  async listTeam(@TenantId() tenantId: string, @Query() query: ListTeamQueryDto) {
    const members = await this.tenantService.getMembers(tenantId);
    const mapped = (members ?? []).map((m) => ({
      id: m.id,
      // An invited member has no display name until they accept.
      name: m.name || m.email?.split('@')[0] || 'Team member',
      email: m.email,
      role: m.role,
      status: m.status,
      avatarUrl: m.avatar_url ?? null,
      lastActiveAt: m.last_login_at ?? null,
      createdAt: m.created_at,
    }));

    // `limit` used to be echoed into the metadata without ever being applied,
    // so the response claimed a page size it had not honoured — and
    // `?limit=abc` reported `null`, because parseInt's NaN serialises that way.
    // Team size is plan-capped, so one page is the normal outcome; the slice is
    // here to make the numbers below it true rather than to page a long list.
    const limit = query.limit ?? DEFAULT_TEAM_PAGE_SIZE;
    const page = mapped.slice(0, limit);

    return {
      data: page,
      pagination: {
        total: mapped.length,
        limit,
        page: 1,
        totalPages: Math.max(1, Math.ceil(mapped.length / limit)),
      },
    };
  }

  @Post('invite')
  @Roles(TeamMemberRole.MANAGER)
  @PlanLimit('seats')
  @ApiOperation({ summary: 'Invite a team member' })
  @ApiResponse({ status: 201, description: 'Result of the invite action' })
  @ApiResponse({
    status: 403,
    description: 'Seat limit reached, caller is not OWNER/MANAGER, or the invited role outranks the caller',
  })
  async inviteMember(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: InviteMemberDto) {
    // @Roles establishes that the caller may manage the team at all; the role
    // to grant arrives in the request body, and capping it against the
    // caller's own role is enforced in the service (shared with
    // `POST /tenant/members/invite`, which reaches the same code).
    return this.tenantService.inviteMember(tenantId, dto, user.sub);
  }

  @Patch(':id/role')
  @Roles(TeamMemberRole.OWNER)
  @ApiOperation({ summary: 'Update member role' })
  @ApiResponse({ status: 200, description: 'The team member with the new role' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Record UUID' })
  @ApiResponse({ status: 403, description: 'Only an owner may grant or revoke roles' })
  async updateRole(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UuidValidationPipe) memberId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    // @Roles(OWNER) already rejected non-owners on the strength of their JWT.
    // This re-reads the stored role so a token minted before a demotion — good
    // for up to 15 more minutes — cannot still grant roles.
    const actor = await this.requireActor(tenantId, user.sub);

    if (actor.role !== TeamMemberRole.OWNER) {
      throw new ForbiddenException('Only an owner may change team member roles');
    }

    // Read before writing: `role` is a single mutable column, so the previous
    // value is gone the moment the update lands and there would be nothing left
    // to diff against. This read also backs the last-owner check below.
    const target = await this.prisma.team_members.findFirst({
      where: { id: memberId, business_id: tenantId, deleted_at: null },
      select: { role: true, email: true },
    });

    // Demoting the last owner leaves the business with nobody who can grant
    // roles, invite members, or manage billing — an unrecoverable state.
    if (dto.role !== TeamMemberRole.OWNER && target?.role === TeamMemberRole.OWNER) {
      const owners = await this.prisma.team_members.count({
        where: { business_id: tenantId, role: TeamMemberRole.OWNER, deleted_at: null },
      });
      if (owners <= 1) {
        throw new ForbiddenException('A business must always have at least one owner');
      }
    }

    const updated = await this.prisma.team_members.update({
      where: { id: memberId, business_id: tenantId },
      data: { role: dto.role },
    });

    // Granting OWNER is the widest-reaching action in the product — it hands
    // over billing, data export, and the ability to grant OWNER again — and it
    // used to leave no record whatsoever of who did it. Written after the
    // update commits, so a rejected change is never described as one that
    // happened.
    await this.audit.record({
      businessId: tenantId,
      actorType: 'TEAM_MEMBER',
      actorId: actor.id,
      actorEmail: user.email ?? null,
      action: AuditAction.UPDATE,
      resourceType: TEAM_MEMBER_RESOURCE,
      resourceId: updated.id,
      before: { role: target?.role ?? null },
      after: { role: updated.role },
      description: `Changed role of ${target?.email ?? memberId} from ${
        target?.role ?? 'unknown'
      } to ${updated.role}`,
    });

    return { id: updated.id, role: updated.role, status: updated.status };
  }

  @Delete(':id')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a team member' })
  @ApiResponse({ status: 204, description: 'Deleted; no content returned' })
  @ApiResponse({ status: 403, description: 'Caller is not OWNER/MANAGER, or the target outranks the caller' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Record UUID' })
  async removeMember(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UuidValidationPipe) memberId: string,
  ) {
    await this.tenantService.removeMember(tenantId, memberId, user.sub);
  }
}
