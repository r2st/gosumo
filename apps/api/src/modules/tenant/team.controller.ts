import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  Logger, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { InviteMemberDto } from './dto/invite-member.dto';
import { PrismaService } from '../../common/services/prisma.service';

@ApiTags('team')
@Controller('auth/team')
export class TeamController {
  private readonly logger = new Logger(TeamController.name);
  constructor(private readonly tenantService: TenantService, private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List team members' })
  async listTeam(@TenantId() tenantId: string, @Query('limit') limit?: string) {
    const members = await this.tenantService.getMembers(tenantId);
    const mapped = (members ?? []).map((m: any) => ({
      id: m.id, name: m.name ?? m.email?.split('@')[0] ?? 'Team member',
      email: m.email, role: m.role, status: m.status ?? 'ACTIVE',
      avatarUrl: m.avatar_url ?? null, lastActiveAt: m.last_active_at ?? null, createdAt: m.created_at,
    }));
    return { data: mapped, pagination: { total: mapped.length, limit: parseInt(limit ?? '100', 10), page: 1, totalPages: 1 } };
  }

  @Post('invite')
  @ApiOperation({ summary: 'Invite a team member' })
  async inviteMember(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: InviteMemberDto) {
    return this.tenantService.inviteMember(tenantId, dto, user.sub);
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Update member role' })
  @ApiParam({ name: 'id' })
  async updateRole(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) memberId: string, @Body() body: { role: string }) {
    const updated = await this.prisma.team_members.update({
      where: { id: memberId, business_id: tenantId },
      data: { role: body.role as any },
    });
    return { id: updated.id, role: updated.role, status: (updated as any).status ?? 'ACTIVE' };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a team member' })
  @ApiParam({ name: 'id' })
  async removeMember(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) memberId: string) {
    await this.tenantService.removeMember(tenantId, memberId);
  }
}
