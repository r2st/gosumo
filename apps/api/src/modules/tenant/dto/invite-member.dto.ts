import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { TeamRole } from '@gosumo/shared';

/**
 * DTO for inviting a new team member to a business.
 *
 * The member is created with status INVITED and an invite token is generated.
 * They join via the invite acceptance flow in the auth module.
 */
export class InviteMemberDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsEnum(TeamRole)
  role!: TeamRole;
}
