import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { MAX_PAGE_SIZE } from '../../../common/validators/pagination.constants';

/** Default page size when the caller does not ask for one. */
export const DEFAULT_TEAM_PAGE_SIZE = 100;

/**
 * Query for `GET /auth/team`.
 *
 * The endpoint read `limit` as a bare `@Query()` string and put
 * `parseInt(limit ?? '100', 10)` straight into the response metadata, so a
 * non-numeric value came back as `null` in the `pagination.limit` field — a
 * caller mistake reported as valid output rather than rejected.
 */
export class ListTeamQueryDto {
  @ApiPropertyOptional({
    description: 'Members per page',
    default: DEFAULT_TEAM_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
