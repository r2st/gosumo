import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MEMBER_SKILLS, MAX_SKILL_LENGTH } from '../tenant.constants';

/**
 * Replace a team member's skill tags.
 *
 * A full replacement rather than an add/remove pair: the dashboard edits this
 * as one multi-select, and two endpoints would let a client that misses a
 * response leave the member holding a skill they were meant to lose.
 */
export class SetMemberSkillsDto {
  @ApiProperty({
    description:
      'Skill tags, e.g. ["HINDI","BILLING"]. Normalised to trimmed upper-case and de-duplicated before storage.',
    type: [String],
    maxItems: MAX_MEMBER_SKILLS,
  })
  @IsArray()
  @ArrayMaxSize(MAX_MEMBER_SKILLS)
  @IsString({ each: true })
  @MaxLength(MAX_SKILL_LENGTH, { each: true })
  skills!: string[];
}
