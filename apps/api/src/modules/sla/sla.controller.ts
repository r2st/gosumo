import { Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SlaService } from './sla.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateSlaPolicyDto,
  UpdateSlaPolicyDto,
  ListBreachesQueryDto,
  ComplianceQueryDto,
} from './dto';

@ApiTags('sla')
@Controller('sla')
export class SlaController {
  constructor(private readonly slaService: SlaService) {}

  // ─────────────────────────────────────────────
  // Policies
  // ─────────────────────────────────────────────

  @Post('policies')
  @ApiOperation({ summary: 'Create an SLA policy' })
  @ApiResponse({ status: 201, description: 'Policy created' })
  @ApiResponse({ status: 400, description: 'resolutionTargetMinutes must be >= firstResponseTargetMinutes' })
  async createPolicy(@TenantId() tenantId: string, @Body() dto: CreateSlaPolicyDto) {
    return this.slaService.createPolicy(tenantId, dto);
  }

  @Get('policies')
  @ApiOperation({ summary: 'List SLA policies, highest priority first' })
  @ApiResponse({ status: 200, description: 'Paginated policy list for this business' })
  async listPolicies(@TenantId() tenantId: string) {
    return this.slaService.listPolicies(tenantId);
  }

  @Get('policies/:id')
  @ApiOperation({ summary: 'Get an SLA policy by ID' })
  @ApiResponse({ status: 200, description: 'The requested policy' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async getPolicy(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.slaService.getPolicy(tenantId, id);
  }

  @Patch('policies/:id')
  @ApiOperation({ summary: 'Update an SLA policy' })
  @ApiResponse({ status: 200, description: 'The updated policy' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async updatePolicy(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateSlaPolicyDto,
  ) {
    return this.slaService.updatePolicy(tenantId, id, dto);
  }

  @Delete('policies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete an SLA policy' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({ status: 204, description: 'Policy deleted' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async deletePolicy(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.slaService.deletePolicy(tenantId, id);
  }

  // ─────────────────────────────────────────────
  // Breaches
  // ─────────────────────────────────────────────

  @Get('breaches')
  @ApiOperation({ summary: 'List SLA breach trackers' })
  @ApiResponse({ status: 200, description: 'Paginated breach list for this business' })
  async listBreaches(@TenantId() tenantId: string, @Query() query: ListBreachesQueryDto) {
    return this.slaService.listBreaches(tenantId, query);
  }

  @Get('breaches/conversation/:conversationId')
  @ApiOperation({ summary: 'Get SLA trackers for a single conversation' })
  @ApiResponse({ status: 200, description: 'The requested conversation' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  async getBreachesForConversation(
    @TenantId() tenantId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
  ) {
    return this.slaService.getBreachesForConversation(tenantId, conversationId);
  }

  @Post('breaches/sweep')
  @ApiOperation({
    summary: 'Sweep overdue SLA trackers with no triggering event yet, marking + escalating breaches',
  })
  @ApiResponse({ status: 201, description: 'Result of the sweep action' })
  async sweepBreaches(@TenantId() tenantId: string) {
    return this.slaService.sweepOverdueBreaches(tenantId);
  }

  @Get('compliance')
  @ApiOperation({ summary: 'SLA compliance rate for a date range (defaults to trailing 30 days)' })
  @ApiResponse({ status: 200, description: 'Paginated compliance list for this business' })
  async getCompliance(@TenantId() tenantId: string, @Query() query: ComplianceQueryDto) {
    return this.slaService.getComplianceSummary(tenantId, query.from, query.to);
  }
}
