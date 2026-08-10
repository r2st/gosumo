import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { RealtyInventoryService } from './realty-inventory.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateProjectDto,
  UpdateProjectDto,
  CreateUnitDto,
  UpdateUnitDto,
  SetAvailabilityDto,
  CreateAssetDto,
  MatchQueryDto,
} from './dto';

/**
 * RealtyInventoryController — projects, units, assets (the grounding layer) and
 * the BLTC→unit matcher. JWT-guarded; @TenantId() supplies the businessId.
 */
@ApiTags('realty-inventory')
@Controller('realty')
export class RealtyInventoryController {
  constructor(private readonly inventory: RealtyInventoryService) {}

  // ── Projects ──
  @Post('projects')
  @ApiOperation({ summary: 'Create a verified project' })
  @ApiResponse({ status: 201, description: 'Project created' })
  async createProject(@TenantId() tenantId: string, @Body() dto: CreateProjectDto) {
    return this.inventory.createProject(tenantId, dto);
  }

  @Get('projects')
  @ApiOperation({ summary: 'List projects' })
  @ApiQuery({ name: 'locality', required: false })
  @ApiQuery({ name: 'status', required: false })
  async listProjects(
    @TenantId() tenantId: string,
    @Query('locality') locality?: string,
    @Query('status') status?: string,
  ) {
    return this.inventory.listProjects(tenantId, { locality, status });
  }

  @Get('projects/:id')
  @ApiOperation({ summary: 'Get a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProject(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.inventory.getProject(tenantId, id);
  }

  @Patch('projects/:id')
  @ApiOperation({ summary: 'Update a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  async updateProject(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.inventory.updateProject(tenantId, id, dto);
  }

  @Delete('projects/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  async deleteProject(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.inventory.deleteProject(tenantId, id);
  }

  // ── Units ──
  @Post('projects/:projectId/units')
  @ApiOperation({ summary: 'Add a unit to a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  async createUnit(
    @TenantId() tenantId: string,
    @Param('projectId', UuidValidationPipe) projectId: string,
    @Body() dto: CreateUnitDto,
  ) {
    return this.inventory.createUnit(tenantId, projectId, dto);
  }

  @Get('projects/:projectId/units')
  @ApiOperation({ summary: 'List a project’s units' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  async listUnits(
    @TenantId() tenantId: string,
    @Param('projectId', UuidValidationPipe) projectId: string,
  ) {
    return this.inventory.listUnits(tenantId, projectId);
  }

  @Patch('units/:unitId')
  @ApiOperation({ summary: 'Update a unit' })
  @ApiParam({ name: 'unitId', description: 'Unit UUID' })
  async updateUnit(
    @TenantId() tenantId: string,
    @Param('unitId', UuidValidationPipe) unitId: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.inventory.updateUnit(tenantId, unitId, dto);
  }

  @Post('units/:unitId/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set unit availability (re-stamps verified_at)' })
  @ApiParam({ name: 'unitId', description: 'Unit UUID' })
  async setAvailability(
    @TenantId() tenantId: string,
    @Param('unitId', UuidValidationPipe) unitId: string,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.inventory.setAvailability(tenantId, unitId, dto.availability);
  }

  @Delete('units/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a unit' })
  @ApiParam({ name: 'unitId', description: 'Unit UUID' })
  async deleteUnit(
    @TenantId() tenantId: string,
    @Param('unitId', UuidValidationPipe) unitId: string,
  ) {
    await this.inventory.deleteUnit(tenantId, unitId);
  }

  // ── Assets ──
  @Post('projects/:projectId/assets')
  @ApiOperation({ summary: 'Publish a verified asset (auto-versions, supersedes prior)' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  async publishAsset(
    @TenantId() tenantId: string,
    @Param('projectId', UuidValidationPipe) projectId: string,
    @Body() dto: CreateAssetDto,
  ) {
    return this.inventory.publishAsset(tenantId, projectId, dto);
  }

  @Get('projects/:projectId/assets')
  @ApiOperation({ summary: 'List a project’s assets' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  async listAssets(
    @TenantId() tenantId: string,
    @Param('projectId', UuidValidationPipe) projectId: string,
  ) {
    return this.inventory.listAssets(tenantId, projectId);
  }

  // ── Matching ──
  @Get('match')
  @ApiOperation({ summary: 'Match ad-hoc BLTC criteria against fresh AVAILABLE units' })
  async match(@TenantId() tenantId: string, @Query() query: MatchQueryDto) {
    return this.inventory.match(tenantId, query);
  }

  @Post('leads/:leadId/match')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Match a lead’s BLTC profile and record matched units' })
  @ApiParam({ name: 'leadId', description: 'Lead UUID' })
  async matchForLead(
    @TenantId() tenantId: string,
    @Param('leadId', UuidValidationPipe) leadId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventory.matchForLead(tenantId, leadId, limit ? parseInt(limit, 10) : 3);
  }
}
