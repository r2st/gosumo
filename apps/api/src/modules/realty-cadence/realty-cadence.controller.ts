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
import { RealtyCadenceService } from './realty-cadence.service';
import { CadenceEngineService } from './cadence-engine.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateTemplateDto,
  UpdateTemplateDto,
  SetTemplateApprovalDto,
  ListTemplatesQueryDto,
  CreateCadenceDto,
  UpdateCadenceDto,
  ListCadencesQueryDto,
  EnrollLeadDto,
  ListEnrollmentsQueryDto,
} from './dto';

/**
 * RealtyCadenceController — the follow-up engine's REST surface: the WhatsApp
 * template registry, declarative cadences, manual enrolment, and the engine
 * tick. JWT-guarded globally; @TenantId() supplies the scoped businessId.
 */
@ApiTags('realty-cadence')
@Controller('realty/cadence')
export class RealtyCadenceController {
  constructor(
    private readonly cadenceService: RealtyCadenceService,
    private readonly engine: CadenceEngineService,
  ) {}

  // ── Seed ─────────────────────────────────────

  @Post('seed')
  @ApiOperation({ summary: 'Install the 12 default templates + 3 default cadences' })
  @ApiResponse({ status: 201, description: 'Seeded counts' })
  async seed(@TenantId() tenantId: string) {
    return this.cadenceService.seedDefaults(tenantId);
  }

  // ── Templates ────────────────────────────────

  @Post('templates')
  @ApiOperation({ summary: 'Create a WhatsApp message template' })
  @ApiResponse({ status: 201, description: 'Template created' })
  @ApiResponse({ status: 409, description: 'Template name already exists' })
  async createTemplate(@TenantId() tenantId: string, @Body() dto: CreateTemplateDto) {
    return this.cadenceService.createTemplate(tenantId, dto);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List templates' })
  async listTemplates(@TenantId() tenantId: string, @Query() query: ListTemplatesQueryDto) {
    return this.cadenceService.listTemplates(tenantId, query);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get a template' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  async getTemplate(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.cadenceService.getTemplate(tenantId, id);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update a template (content change re-opens approval)' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  async updateTemplate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.cadenceService.updateTemplate(tenantId, id, dto);
  }

  @Post('templates/:id/approval')
  @ApiOperation({ summary: 'Set a template approval status (PENDING/APPROVED/REJECTED)' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  @HttpCode(HttpStatus.OK)
  async setApproval(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: SetTemplateApprovalDto,
  ) {
    return this.cadenceService.setTemplateApproval(tenantId, id, dto);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a template' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  async deleteTemplate(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.cadenceService.deleteTemplate(tenantId, id);
  }

  // ── Cadences ─────────────────────────────────

  @Post('cadences')
  @ApiOperation({ summary: 'Create a cadence with steps' })
  @ApiResponse({ status: 201, description: 'Cadence created' })
  async createCadence(@TenantId() tenantId: string, @Body() dto: CreateCadenceDto) {
    return this.cadenceService.createCadence(tenantId, dto);
  }

  @Get('cadences')
  @ApiOperation({ summary: 'List cadences' })
  async listCadences(@TenantId() tenantId: string, @Query() query: ListCadencesQueryDto) {
    return this.cadenceService.listCadences(tenantId, query);
  }

  @Get('cadences/:id')
  @ApiOperation({ summary: 'Get a cadence with its steps' })
  @ApiParam({ name: 'id', description: 'Cadence UUID' })
  async getCadence(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.cadenceService.getCadence(tenantId, id);
  }

  @Patch('cadences/:id')
  @ApiOperation({ summary: 'Update a cadence (steps replace the full list when present)' })
  @ApiParam({ name: 'id', description: 'Cadence UUID' })
  async updateCadence(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateCadenceDto,
  ) {
    return this.cadenceService.updateCadence(tenantId, id, dto);
  }

  @Delete('cadences/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a cadence' })
  @ApiParam({ name: 'id', description: 'Cadence UUID' })
  async deleteCadence(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.cadenceService.deleteCadence(tenantId, id);
  }

  // ── Enrollments + engine ─────────────────────

  @Get('enrollments')
  @ApiOperation({ summary: 'List cadence enrollments' })
  async listEnrollments(@TenantId() tenantId: string, @Query() query: ListEnrollmentsQueryDto) {
    return this.cadenceService.listEnrollments(tenantId, query);
  }

  @Post('enroll')
  @ApiOperation({ summary: 'Manually enrol a lead into a trigger cadence' })
  @ApiResponse({ status: 200, description: 'Enrolment (or null if no active cadence)' })
  @HttpCode(HttpStatus.OK)
  async enroll(@TenantId() tenantId: string, @Body() dto: EnrollLeadDto) {
    return this.engine.enroll(tenantId, dto.leadId, dto.trigger);
  }

  @Post('run')
  @ApiOperation({ summary: 'Process due cadence steps for this tenant (engine tick)' })
  @ApiResponse({ status: 200, description: 'Processing summary' })
  @HttpCode(HttpStatus.OK)
  async run(@TenantId() tenantId: string) {
    return this.engine.processDueEnrollments(new Date(), tenantId);
  }
}
