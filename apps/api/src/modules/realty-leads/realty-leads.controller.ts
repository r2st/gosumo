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
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { RealtyLeadsService } from './realty-leads.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { PlanLimit } from '../billing/plan.decorator';
import {
  CreateLeadDto,
  UpdateLeadDto,
  BltcUpdateDto,
  TransitionStageDto,
  CaptureMemoryDto,
  AssignAgentDto,
  ListLeadsQueryDto,
} from './dto';

/**
 * RealtyLeadsController — REST surface for the AI Lead Manager pipeline.
 * All routes are JWT-guarded globally; @TenantId() supplies the scoped businessId.
 */
@ApiTags('realty-leads')
@Controller('realty/leads')
export class RealtyLeadsController {
  constructor(private readonly leadsService: RealtyLeadsService) {}

  @Post()
  @PlanLimit('leads')
  @ApiOperation({ summary: 'Capture a new lead (records attribution at birth)' })
  @ApiResponse({ status: 201, description: 'Lead created' })
  @ApiResponse({ status: 409, description: 'Lead with this phone already exists' })
  @ApiResponse({ status: 429, description: 'Monthly lead limit reached — upgrade required' })
  async create(@TenantId() tenantId: string, @Body() dto: CreateLeadDto) {
    return this.leadsService.createLead(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List leads with filters and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated leads' })
  async list(@TenantId() tenantId: string, @Query() query: ListLeadsQueryDto) {
    return this.leadsService.listLeads(tenantId, query);
  }

  @Get('board')
  @ApiOperation({ summary: 'Pipeline board — lead counts per stage' })
  @ApiResponse({ status: 200, description: 'Stage counts' })
  async board(@TenantId() tenantId: string) {
    return this.leadsService.getBoard(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single lead' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead details' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.leadsService.getLead(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update basic lead fields' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.leadsService.updateLead(tenantId, id, dto);
  }

  @Post(':id/bltc')
  @ApiOperation({ summary: 'Apply a BLTC qualification update (merge + rescore)' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Updated lead + contradictions + score' })
  @HttpCode(HttpStatus.OK)
  async applyBltc(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: BltcUpdateDto,
  ) {
    return this.leadsService.applyBltcUpdate(tenantId, id, dto);
  }

  @Post(':id/stage')
  @ApiOperation({ summary: 'Transition a lead to a new pipeline stage' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  @HttpCode(HttpStatus.OK)
  async transition(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: TransitionStageDto,
  ) {
    return this.leadsService.transitionStage(tenantId, id, dto);
  }

  @Post(':id/memory')
  @ApiOperation({ summary: 'Append facts / objections / promises to lead memory' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  @HttpCode(HttpStatus.OK)
  async captureMemory(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CaptureMemoryDto,
  ) {
    return this.leadsService.captureMemory(tenantId, id, dto);
  }

  @Post(':id/assign')
  @ApiOperation({ summary: 'Assign the lead to an agent' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  @HttpCode(HttpStatus.OK)
  async assign(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AssignAgentDto,
  ) {
    return this.leadsService.assignAgent(tenantId, id, dto.agentId);
  }

  @Post(':id/opt-out')
  @ApiOperation({ summary: 'Honor a buyer opt-out — halts all automation' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 200, description: 'Lead updated' })
  @HttpCode(HttpStatus.OK)
  async optOut(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.leadsService.setOptOut(tenantId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a lead' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Lead UUID' })
  @ApiResponse({ status: 204, description: 'Lead deleted' })
  async remove(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.leadsService.deleteLead(tenantId, id);
  }
}
