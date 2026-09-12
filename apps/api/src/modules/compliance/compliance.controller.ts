import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ComplianceService } from './compliance.service';
import { ConsentService } from './consent.service';
import { RetentionService } from './retention.service';
import { CorrectionDto, ErasureDto, UpdateComplianceSettingsDto } from './dto';

/**
 * ComplianceController — the DPDPA workflow surface (business plan §21).
 * All routes are JWT-guarded globally; @TenantId() supplies the scoped businessId.
 */
@ApiTags('compliance')
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly consent: ConsentService,
    private readonly retention: RetentionService,
  ) {}

  // ── Data-principal rights ─────────────────────────────────────────────────────

  @Get('data-request/:phone')
  @ApiOperation({ summary: 'Right of access — all data held for a phone number' })
  @ApiParam({ name: 'phone', description: 'Buyer phone (any Indian format)' })
  @ApiResponse({ status: 200, description: 'Lead profile, messages, and consent history' })
  async dataRequest(@TenantId() tenantId: string, @Param('phone') phone: string) {
    return this.compliance.dataRequest(tenantId, phone);
  }

  @Post('correction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Right to correction — update personal data on request' })
  @ApiResponse({ status: 200, description: 'Corrected lead' })
  @ApiResponse({ status: 404, description: 'No lead found for phone' })
  async correction(@TenantId() tenantId: string, @Body() dto: CorrectionDto) {
    return this.compliance.correction(tenantId, dto);
  }

  // Erasure is irreversible: it anonymizes the lead, its messages, and its
  // consent trail with nothing to restore from. Answering an access or
  // correction request is day-to-day support work and stays open to any
  // member; destroying the record is not.
  @Post('erasure')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Right to erasure — anonymize all PII for a phone' })
  @ApiResponse({ status: 200, description: 'Erasure result' })
  @ApiResponse({ status: 403, description: 'Only OWNER or MANAGER may erase a data principal' })
  async erasure(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ErasureDto,
  ) {
    return this.compliance.erasure(tenantId, dto.phone, 'REQUEST', new Date(), {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  @Get('consent/:phone')
  @ApiOperation({ summary: 'Consent history for a phone number' })
  @ApiParam({ name: 'phone', description: 'Buyer phone (any Indian format)' })
  @ApiResponse({ status: 200, description: 'Consent ledger for the phone' })
  async consentHistory(@TenantId() tenantId: string, @Param('phone') phone: string) {
    const consents = await this.consent.getHistory(tenantId, phone);
    return { phone, consents };
  }

  // ── Settings + reporting ──────────────────────────────────────────────────────

  @Get('settings')
  @ApiOperation({ summary: 'Retention policy + data-processor agreement status' })
  @ApiResponse({ status: 200, description: 'Compliance settings' })
  async getSettings(@TenantId() tenantId: string) {
    return this.compliance.getSettings(tenantId);
  }

  // Shortening the retention window decides when customer data is destroyed
  // in bulk, and the data-processor agreement is a legal attestation.
  @Put('settings')
  @Roles(TeamMemberRole.OWNER)
  @ApiOperation({ summary: 'Update retention window / data-processor agreement' })
  @ApiResponse({ status: 200, description: 'Updated compliance settings' })
  @ApiResponse({ status: 403, description: 'Only an owner may change compliance settings' })
  async updateSettings(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateComplianceSettingsDto,
  ) {
    return this.compliance.updateSettings(tenantId, dto, {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  @Get('report')
  @ApiOperation({ summary: 'Export a DPDPA compliance report for the business' })
  @ApiResponse({ status: 200, description: 'Compliance report' })
  async report(@TenantId() tenantId: string) {
    return this.compliance.complianceReport(tenantId);
  }

  // ── Retention (manual trigger) ────────────────────────────────────────────────

  // A manual sweep deletes every record past the retention window across the
  // whole business in one call.
  @Post('retention/run')
  @Roles(TeamMemberRole.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the retention sweep now for this business' })
  @ApiResponse({ status: 200, description: 'Retention run result' })
  @ApiResponse({ status: 403, description: 'Only an owner may trigger a retention sweep' })
  async runRetention(@TenantId() tenantId: string) {
    return this.retention.runForBusiness(tenantId);
  }
}
