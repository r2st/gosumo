import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { TeamMemberRole } from '@gosumo/database';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { TenantRateLimit } from '../../common/rate-limit/tenant-rate-limit.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { clientIp } from '../../common/utils/client-ip.util';
import { DataExportService, ExportActor } from './data-export.service';
import { ResolveSubjectDto } from './dto';

/**
 * DataExportController — subject-access exports for a customer.
 *
 * Every route is gated at MANAGER. The `compliance` module lets any member
 * answer an access request for a single realty lead, and that is right for
 * what it returns; this returns a customer's entire commercial and
 * conversational history in one response, which is the largest single
 * disclosure of personal data the API can make. It is rationed by the `export`
 * bucket for the same reason: a leaked token should not be able to drain a
 * tenant's customer records faster than anyone can notice.
 */
@ApiTags('data-export')
@Controller('data-export')
@Roles(TeamMemberRole.MANAGER)
export class DataExportController {
  constructor(private readonly dataExport: DataExportService) {}

  @Get('clients/:clientId/summary')
  @TenantRateLimit('export')
  @ApiOperation({
    summary: 'How much data an export would contain, without building it',
    description:
      'Counts every collection and names the sections that would be truncated at ' +
      'the current export caps. Call this first for a long-standing customer.',
  })
  @ApiParam({ name: 'clientId', description: 'Customer UUID' })
  @ApiResponse({ status: 200, description: 'Per-collection counts' })
  @ApiResponse({ status: 404, description: 'No such customer for this business' })
  async summary(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.dataExport.summarize(tenantId, clientId);
  }

  @Get('clients/:clientId')
  @TenantRateLimit('export')
  @ApiOperation({
    summary: 'Export everything stored about one customer',
    description:
      'Profile, channel identities, conversations, messages, orders, payments, ' +
      'bookings, notifications and consent history. Bounded per section; the ' +
      'response declares what was truncated and what was withheld.',
  })
  @ApiParam({ name: 'clientId', description: 'Customer UUID' })
  @ApiResponse({ status: 200, description: 'The export bundle' })
  @ApiResponse({ status: 403, description: 'Only a MANAGER or OWNER may export customer data' })
  @ApiResponse({ status: 404, description: 'No such customer for this business' })
  @ApiResponse({ status: 429, description: 'Export rate limit exceeded' })
  async exportClient(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.dataExport.exportClient(tenantId, clientId, this.actorOf(user, req));
  }

  @Post('resolve')
  @TenantRateLimit('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Find a customer by the phone or email they gave you',
    description:
      'A data subject knows the number they messaged from, not their UUID. ' +
      'Returns the client id to export.',
  })
  @ApiResponse({ status: 200, description: 'The matching customer' })
  @ApiResponse({ status: 400, description: 'Neither phone nor email was supplied' })
  @ApiResponse({ status: 404, description: 'No customer matches that identifier' })
  async resolve(@TenantId() tenantId: string, @Body() dto: ResolveSubjectDto) {
    const client = await this.dataExport.resolveSubject(tenantId, dto);
    // Deliberately narrow. This route exists to turn an identifier the caller
    // already holds into an id; returning the profile would make it a contact
    // lookup that happens to sit behind the export's rate limit.
    return { clientId: client.id, name: client.name };
  }

  /**
   * Who to attribute the export to on the audit trail.
   *
   * Snapshotted from the token and the request rather than looked up, because
   * the trail has to survive the team member being removed — which is exactly
   * the case where anyone goes looking.
   */
  private actorOf(user: AuthenticatedUser, req: Request): ExportActor {
    return {
      teamMemberId: user.sub,
      email: user.email ?? null,
      requestId: (req.headers['x-correlation-id'] as string | undefined) ?? null,
      ipAddress: clientIp(req),
    };
  }
}
