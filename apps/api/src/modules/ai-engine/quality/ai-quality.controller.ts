import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AiQualityService } from './ai-quality.service';
import {
  QualityMetricsQueryDto,
  QualityRecomputeResultDto,
  QualitySummaryDto,
  RecomputeQualityDto,
} from './dto';

/**
 * AiQualityController — the AI response-quality surface.
 *
 * Routes:
 *   GET  /ai/quality            — confidence distribution, routing + override
 *                                 rates, and latency, overall and per channel
 *   POST /ai/quality/recompute  — rebuild this tenant's buckets from an instant
 *
 * Tenant-scoped via `@TenantId()`. The recompute route is owner/admin only: it
 * deletes rollup rows, and a wide `from` is minutes of database work.
 */
@ApiTags('AI Quality')
@Controller('ai/quality')
export class AiQualityController {
  constructor(private readonly quality: AiQualityService) {}

  @Get()
  @ApiOperation({ summary: 'AI response quality metrics for this business' })
  @ApiResponse({
    status: 200,
    description: 'Confidence distribution, routing + override rates, and latency',
    type: QualitySummaryDto,
  })
  @ApiResponse({ status: 400, description: 'Window is inverted, unparseable, or too wide' })
  async getSummary(
    @TenantId() tenantId: string,
    @Query() query: QualityMetricsQueryDto,
  ): Promise<QualitySummaryDto> {
    return this.quality.getSummary(tenantId, query);
  }

  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  @Roles(TeamMemberRole.OWNER, TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Rebuild rollup buckets from an instant onwards' })
  @ApiResponse({
    status: 200,
    description: 'Buckets deleted and rewritten',
    type: QualityRecomputeResultDto,
  })
  @ApiResponse({ status: 400, description: 'Window is in the future or too far back' })
  async recompute(
    @TenantId() tenantId: string,
    @Body() dto: RecomputeQualityDto,
  ): Promise<QualityRecomputeResultDto> {
    return this.quality.recompute(tenantId, dto);
  }
}
