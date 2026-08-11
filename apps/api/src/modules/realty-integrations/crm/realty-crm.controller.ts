import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { RealtyIntegrationProvider } from '@prisma/client';
import { CrmPushService } from './crm-push.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../../common/pipes/uuid-validation.pipe';
import { PlanLimit } from '../../billing/plan.decorator';
import { ConnectCrmDto } from '../dto';

/**
 * RealtyCrmController — the settings-UI surface for CRM sync. Every route is
 * gated behind the Developer tier via `@PlanLimit('crm_sync')` (the global
 * PlanGuard turns a non-Developer plan into 403 PLAN_CRM_SYNC_LOCKED).
 */
@ApiTags('realty-integrations')
@Controller('realty/integrations/crm')
@PlanLimit('crm_sync')
export class RealtyCrmController {
  constructor(private readonly crm: CrmPushService) {}

  @Get()
  @ApiOperation({ summary: 'List connected CRMs and their sync status' })
  @ApiResponse({ status: 200, description: 'Paginated crm list for this business' })
  async list(@TenantId() tenantId: string) {
    return this.crm.listConnections(tenantId);
  }

  @Post('connect')
  @ApiOperation({ summary: 'Connect an Indian CRM (Sell.Do / LeadSquared / Privyr)' })
  @ApiResponse({ status: 201, description: 'CRM connected' })
  @ApiResponse({ status: 400, description: 'Invalid credentials' })
  async connect(@TenantId() tenantId: string, @Body() dto: ConnectCrmDto) {
    return this.crm.connect(tenantId, dto.provider, dto.config);
  }

  @Post(':provider/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a connected CRM credential' })
  @ApiResponse({ status: 200, description: 'Result of the test action' })
  @ApiParam({ name: 'provider', enum: RealtyIntegrationProvider, description: 'Provider' })
  async test(
    @TenantId() tenantId: string,
    @Param('provider') provider: RealtyIntegrationProvider,
  ) {
    return this.crm.testConnection(tenantId, provider);
  }

  @Post('leads/:leadId/resync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually push a lead to all connected CRMs' })
  @ApiResponse({ status: 200, description: 'Result of the resync action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'leadId', description: 'Lead UUID' })
  async resync(
    @TenantId() tenantId: string,
    @Param('leadId', UuidValidationPipe) leadId: string,
  ) {
    const results = await this.crm.pushLead(tenantId, leadId, 'manual');
    return { pushed: results.filter((r) => r.ok).length, results };
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a CRM' })
  @ApiResponse({ status: 204, description: 'Deleted; no content returned' })
  @ApiParam({ name: 'provider', enum: RealtyIntegrationProvider, description: 'Provider' })
  async disconnect(
    @TenantId() tenantId: string,
    @Param('provider') provider: RealtyIntegrationProvider,
  ): Promise<void> {
    await this.crm.disconnect(tenantId, provider);
  }
}
