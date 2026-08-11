import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { RealtyDlqService } from './realty-dlq.service';
import { RealtyHealthService } from './realty-health.service';
import { RealtyContradictionService } from './realty-contradiction.service';
import { RealtyRateLimit } from './realty-rate-limit.decorator';
import {
  ListDeadLettersQueryDto,
  ResolveDeadLetterDto,
  ValidateBltcDto,
} from './dto';

/**
 * RealtyHardeningController — the Phase-7 operations surface: soak-readiness,
 * the dead-letter queue (inspect / replay / resolve), and BLTC contradiction
 * checks. All routes are JWT-guarded globally and tenant-scoped via @TenantId().
 */
@ApiTags('realty-ops')
@Controller('realty/ops')
export class RealtyHardeningController {
  constructor(
    private readonly dlq: RealtyDlqService,
    private readonly health: RealtyHealthService,
    private readonly contradictions: RealtyContradictionService,
  ) {}

  // ── Readiness ────────────────────────────────

  @Get('health')
  @ApiOperation({ summary: 'Soak-readiness — DB, DLQ backlog, rate-limiter pressure' })
  @ApiResponse({ status: 200, description: 'Aggregated readiness (pass/warn/fail)' })
  async readiness(@TenantId() _tenantId: string) {
    return this.health.readiness();
  }

  // ── Dead-letter queue ────────────────────────

  @Get('dlq')
  @ApiOperation({ summary: 'List dead-lettered realty operations' })
  @ApiResponse({ status: 200, description: 'Dead letters (newest first)' })
  async listDeadLetters(
    @TenantId() tenantId: string,
    @Query() query: ListDeadLettersQueryDto,
  ) {
    return this.dlq.list(tenantId, {
      status: query.status,
      source: query.source,
      operation: query.operation,
      limit: query.limit,
    });
  }

  @Get('dlq/stats')
  @ApiOperation({ summary: 'Dead-letter counts by status' })
  @ApiResponse({ status: 200, description: 'Counts per status' })
  async dlqStats(@TenantId() tenantId: string) {
    return this.dlq.stats(tenantId);
  }

  @Get('dlq/:id')
  @ApiOperation({ summary: 'Get a single dead letter' })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'Dead-letter detail' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.dlq.get(tenantId, id);
  }

  @Post('dlq/:id/replay')
  @RealtyRateLimit('dlq-replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-execute a dead-lettered operation via its replayer' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'Replay outcome (status REPLAYED / still PENDING)' })
  async replayDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.dlq.replay(tenantId, id);
  }

  @Post('dlq/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a dead letter RESOLVED or DISCARDED' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'Updated dead letter' })
  async resolveDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveDeadLetterDto,
  ) {
    return this.dlq.resolve(tenantId, id, dto.status, dto.note);
  }

  // ── BLTC contradiction checks ────────────────

  @Post('bltc/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a supplied BLTC profile for internal consistency' })
  @ApiResponse({ status: 200, description: 'Contradiction result' })
  async validateBltc(@TenantId() _tenantId: string, @Body() dto: ValidateBltcDto) {
    return this.contradictions.validateProfile(dto);
  }

  @Get('bltc/lead/:id')
  @ApiOperation({ summary: 'Validate a stored lead’s BLTC profile' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Contradiction result' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async validateLeadBltc(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.contradictions.validateLead(tenantId, id);
  }
}
