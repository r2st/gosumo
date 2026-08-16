import { Controller, Get, Param, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';
import { AuditService } from './audit.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogFilterDto, ListAuditLogsQueryDto } from './dto';

/**
 * AuditController — read-only surface over the append-only audit trail.
 *
 * Gated at MANAGER. These rows carry who changed what, alongside `ip_address`
 * and `user_agent` for every acting member — a staff-visible endpoint would
 * make the trail a way to watch colleagues rather than a way to answer "who
 * granted that". The rest of the API leaves reads open on the principle that
 * settings pages must render; this one is the exception because the data *is*
 * the surveillance, not a view of the business's own configuration.
 *
 * There are no write routes and there will not be: `audit_logs` refuses UPDATE
 * and DELETE in the database.
 */
@ApiTags('audit')
@Controller('audit-logs')
export class AuditController {
  private readonly logger = new Logger(AuditController.name);

  constructor(private readonly service: AuditService) {}

  @Get()
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'List audit log entries, newest first' })
  @ApiResponse({ status: 200, description: 'A page of audit entries for this business' })
  @ApiResponse({
    status: 400,
    description: 'Malformed or inverted window, or a window longer than 366 days',
  })
  @ApiResponse({ status: 403, description: 'Caller is not OWNER/MANAGER' })
  async list(@TenantId() tenantId: string, @Query() query: ListAuditLogsQueryDto) {
    return this.service.list(tenantId, query);
  }

  @Get('summary')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Aggregate audit counts by action and actor' })
  @ApiResponse({ status: 200, description: 'Counts over the requested window' })
  @ApiResponse({ status: 400, description: 'Malformed or oversized window' })
  @ApiResponse({ status: 403, description: 'Caller is not OWNER/MANAGER' })
  async summary(@TenantId() tenantId: string, @Query() query: AuditLogFilterDto) {
    return this.service.summary(tenantId, query);
  }

  @Get('export')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Every entry in the window, up to the export ceiling' })
  @ApiResponse({ status: 200, description: 'Audit entries, newest first' })
  @ApiResponse({ status: 400, description: 'Malformed or oversized window' })
  @ApiResponse({ status: 403, description: 'Caller is not OWNER/MANAGER' })
  async export(@TenantId() tenantId: string, @Query() query: AuditLogFilterDto) {
    return this.service.export(tenantId, query);
  }

  // Declared last: `:id` matches any single segment and would otherwise swallow
  // the static routes above it. See route-shadowing-contract.spec.ts.
  @Get(':id')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Get one audit entry' })
  @ApiResponse({ status: 200, description: 'The requested entry' })
  @ApiResponse({ status: 403, description: 'Caller is not OWNER/MANAGER' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Record UUID' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.service.get(tenantId, id);
  }
}
