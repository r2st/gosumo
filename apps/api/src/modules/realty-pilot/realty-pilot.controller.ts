import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { MigrationService } from './migration.service';
import { AutonomyService } from './autonomy.service';
import { LaunchGateService } from './launch-gate.service';
import { NoShipService } from './no-ship.service';
import {
  ImportLeadsDto,
  ImportInventoryDto,
  ListMigrationsQueryDto,
  AdvanceAutonomyDto,
  EvaluateLaunchGateDto,
  RecordNoShipDto,
} from './dto';

/**
 * RealtyPilotController — the pilot-migration console (Phase 8): data migration
 * (leads/contacts/inventory), the evidence-driven autonomy dial, the no-ship
 * ledger, and the launch-readiness gate. JWT-guarded; @TenantId() scopes it.
 */
@ApiTags('realty-pilot')
@Controller('realty/pilot')
export class RealtyPilotController {
  constructor(
    private readonly migrationService: MigrationService,
    private readonly autonomyService: AutonomyService,
    private readonly launchGateService: LaunchGateService,
    private readonly noShipService: NoShipService,
  ) {}

  // ── Migration ────────────────────────────────

  @Post('migrate/leads')
  @ApiOperation({ summary: 'Import pilot leads/contacts (E.164 identity-merge); dryRun to validate only' })
  @ApiResponse({ status: 200, description: 'Per-row import outcome; no writes when dryRun is set' })
  @HttpCode(HttpStatus.OK)
  async importLeads(
    @TenantId() tenantId: string,
    @Body() dto: ImportLeadsDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.migrationService.importLeads(tenantId, dto, userId);
  }

  @Post('migrate/inventory')
  @ApiOperation({ summary: 'Import pilot inventory (projects + units); dryRun to validate only' })
  @ApiResponse({ status: 200, description: 'Per-row import outcome; no writes when dryRun is set' })
  @HttpCode(HttpStatus.OK)
  async importInventory(
    @TenantId() tenantId: string,
    @Body() dto: ImportInventoryDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.migrationService.importInventory(tenantId, dto, userId);
  }

  @Get('migrations')
  @ApiOperation({ summary: 'List past migration runs' })
  @ApiResponse({ status: 200, description: 'Paginated migration list for this business' })
  async listMigrations(@TenantId() tenantId: string, @Query() query: ListMigrationsQueryDto) {
    return this.migrationService.listRuns(tenantId, query);
  }

  @Get('migrations/:id')
  @ApiOperation({ summary: 'Get a single migration run' })
  @ApiResponse({ status: 200, description: 'The requested migration' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Migration run UUID' })
  async getMigration(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    const run = await this.migrationService.getRun(tenantId, id);
    if (!run) throw new NotFoundException('Migration run not found');
    return run;
  }

  // ── Autonomy dial ────────────────────────────

  @Get('autonomy')
  @ApiOperation({ summary: 'Preview the evidence-driven autonomy-dial recommendation (no change)' })
  @ApiResponse({ status: 200, description: 'Paginated autonomy list for this business' })
  async evaluateAutonomy(@TenantId() tenantId: string) {
    return this.autonomyService.evaluate(tenantId);
  }

  @Post('autonomy/advance')
  @ApiOperation({ summary: 'Advance (or preview) the autonomy dial on the current evidence' })
  @ApiResponse({ status: 200, description: 'Result of the advance action' })
  @HttpCode(HttpStatus.OK)
  async advanceAutonomy(
    @TenantId() tenantId: string,
    @Body() dto: AdvanceAutonomyDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.autonomyService.advance(tenantId, dto.apply ?? true, userId);
  }

  @Get('autonomy/events')
  @ApiOperation({ summary: 'The autonomy-dial change ledger (append-only)' })
  @ApiResponse({ status: 200, description: 'Paginated event list for this business' })
  async autonomyEvents(@TenantId() tenantId: string) {
    return this.autonomyService.listEvents(tenantId);
  }

  // ── No-ship ledger ───────────────────────────

  @Post('no-ship')
  @ApiOperation({ summary: 'Record a no-ship incident (QA / soak-drill / manual report)' })
  @ApiResponse({ status: 201, description: 'Result of the no ship action' })
  @HttpCode(HttpStatus.CREATED)
  async recordNoShip(@TenantId() tenantId: string, @Body() dto: RecordNoShipDto) {
    return this.noShipService.recordFromDto(tenantId, dto);
  }

  @Get('no-ship')
  @ApiOperation({ summary: 'List recorded no-ship incidents' })
  @ApiResponse({ status: 200, description: 'Paginated no ship list for this business' })
  async listNoShip(@TenantId() tenantId: string) {
    return this.noShipService.list(tenantId);
  }

  // ── Launch-readiness gate ────────────────────

  @Get('launch-gate')
  @ApiOperation({ summary: 'Evaluate the launch-readiness gate (auto metrics; response-P95 unmeasured)' })
  @ApiResponse({ status: 200, description: 'Paginated launch gate list for this business' })
  async launchGate(@TenantId() tenantId: string) {
    return this.launchGateService.evaluate(tenantId);
  }

  @Post('launch-gate/evaluate')
  @ApiOperation({ summary: 'Evaluate the launch-readiness gate with a measured response-P95 + window' })
  @ApiResponse({ status: 200, description: 'Result of the evaluate action' })
  @HttpCode(HttpStatus.OK)
  async launchGateEvaluate(@TenantId() tenantId: string, @Body() dto: EvaluateLaunchGateDto) {
    return this.launchGateService.evaluate(
      tenantId,
      { responseP95Seconds: dto.responseP95Seconds },
      dto.windowDays,
    );
  }
}
