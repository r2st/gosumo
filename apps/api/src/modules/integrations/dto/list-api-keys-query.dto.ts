import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { MAX_PAGE_SIZE } from '../../../common/validators/pagination.constants';

/** Default page size when the caller does not ask for one. */
export const DEFAULT_API_KEY_PAGE_SIZE = 100;

/**
 * Query for `GET /api-keys`.
 *
 * This endpoint already had a hand-rolled `parseLimit` that clamped rather than
 * rejected, which was safe — NaN never reached Prisma — but silent: `?limit=abc`
 * and `?limit=5000` both returned a page of 100 while reporting `limit: 100`,
 * so a caller with a broken paging loop got no signal. Every other list
 * endpoint answers 400 for the same input. This makes that uniform, and folds
 * the local 200 ceiling into the shared one.
 */
export class ListApiKeysQueryDto {
  @ApiPropertyOptional({
    description: 'Keys per page',
    default: DEFAULT_API_KEY_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
