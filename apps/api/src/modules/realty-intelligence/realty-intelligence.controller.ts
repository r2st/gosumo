import {
  Controller,
  Get,
  Post,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { ListAggregatesQueryDto, CorridorPriorsQueryDto } from './dto';

/**
 * RealtyIntelligenceController — REST surface for the L1 micro-market layer.
 * JWT-guarded globally; @TenantId() supplies the scoped businessId. Aggregates
 * returned are always this tenant's own view (RLS + business_id scoping).
 */
@ApiTags('realty-intelligence')
@Controller('realty/intelligence')
export class RealtyIntelligenceController {
  constructor(private readonly service: RealtyIntelligenceService) {}

  @Get('aggregates')
  @ApiOperation({ summary: 'List stored corridor aggregates (optionally filtered)' })
  @ApiResponse({ status: 200, description: 'Corridor aggregates' })
  async listAggregates(@TenantId() tenantId: string, @Query() query: ListAggregatesQueryDto) {
    return this.service.listAggregates(tenantId, {
      corridor: query.corridor,
      metricType: query.metricType,
    });
  }

  @Get('corridors')
  @ApiOperation({ summary: 'List corridors that currently have aggregates' })
  @ApiResponse({ status: 200, description: 'Corridor keys' })
  async listCorridors(@TenantId() tenantId: string) {
    return { corridors: await this.service.listCorridors(tenantId) };
  }

  @Get('corridor-priors')
  @ApiOperation({ summary: 'Latest priors for one corridor (AI prompt injection)' })
  @ApiResponse({ status: 200, description: 'Latest aggregate per metric' })
  async corridorPriors(@TenantId() tenantId: string, @Query() query: CorridorPriorsQueryDto) {
    const priors = await this.service.getCorridorPriors(
      tenantId,
      query.corridor,
      query.metricTypes,
    );
    const context = await this.service.buildCorridorContext(tenantId, query.corridor);
    return { corridor: query.corridor, priors, promptContext: context };
  }

  @Get('source-quality')
  @ApiOperation({ summary: 'Per-source ROI report for this business' })
  @ApiResponse({ status: 200, description: 'Source quality report' })
  async sourceQuality(@TenantId() tenantId: string) {
    return this.service.getSourceQualityReport(tenantId);
  }

  @Get('opt-in')
  @ApiOperation({ summary: 'Current intelligence-contribution consent status' })
  @ApiResponse({ status: 200, description: 'Opt-in status' })
  async optInStatus(@TenantId() tenantId: string) {
    return { optIn: await this.service.getOptInStatus(tenantId) };
  }

  @Post('opt-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consent to contribute anonymized corridor patterns' })
  @ApiResponse({ status: 200, description: 'Opted in' })
  async optIn(@TenantId() tenantId: string) {
    return this.service.optIn(tenantId);
  }

  @Post('opt-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw intelligence-contribution consent' })
  @ApiResponse({ status: 200, description: 'Opted out' })
  async optOut(@TenantId() tenantId: string) {
    return this.service.optOut(tenantId);
  }
}
