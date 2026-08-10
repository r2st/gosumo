import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';

/**
 * Team-member role change.
 *
 * `PATCH /auth/team/:id/role` previously took `@Body() body: { role: string }`
 * — an inline type the ValidationPipe cannot see — and wrote
 * `body.role as any` straight into `team_members.role`. Two things followed
 * from that: any string reached the enum column, and nothing constrained
 * *which* role a caller could hand out, so a member could promote themselves
 * to OWNER by PATCHing their own id.
 *
 * Restricting the value to the schema's `TeamMemberRole` closes the first.
 * The second is enforced in the handler, which is where the acting user's own
 * role is known.
 */
export class UpdateMemberRoleDto {
  @ApiProperty({ enum: TeamMemberRole, description: 'Role to assign to the member' })
  @IsEnum(TeamMemberRole)
  role!: TeamMemberRole;
}
