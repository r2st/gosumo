import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { TeamMemberRole, DataExportArchiveFormat } from '@gosumo/database';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { TenantRateLimit } from '../../common/rate-limit/tenant-rate-limit.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { clientIp } from '../../common/utils/client-ip.util';
import { DataExportService, ExportActor } from './data-export.service';
import { ExportJobService } from './export-job.service';
import {
  DownloadArchiveDto,
  ListArchivesQueryDto,
  RequestArchiveDto,
  ResolveSubjectDto,
} from './dto';

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
  constructor(
    private readonly dataExport: DataExportService,
    private readonly archives: ExportJobService,
  ) {}

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

  // ─────────────────────────────────────────────
  // Archives — the asynchronous path
  // ─────────────────────────────────────────────

  @Post('clients/:clientId/archives')
  @TenantRateLimit('export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a downloadable archive of everything stored about one customer',
    description:
      'Returns immediately; the archive is built on a queue. The response carries a ' +
      'download token that is shown exactly once and cannot be recovered — only its ' +
      'hash is stored.',
  })
  @ApiParam({ name: 'clientId', description: 'Customer UUID' })
  @ApiResponse({ status: 202, description: 'Archive requested; poll or download with the token' })
  @ApiResponse({ status: 400, description: 'Too many archives already building for this business' })
  @ApiResponse({ status: 404, description: 'No such customer for this business' })
  async requestArchive(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Body() dto: RequestArchiveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.archives.requestArchive(
      tenantId,
      clientId,
      dto.format ?? DataExportArchiveFormat.JSON,
      this.actorOf(user, req),
    );
  }

  @Get('archives')
  @ApiOperation({ summary: 'List this business’s export archives' })
  @ApiResponse({ status: 200, description: 'Archive metadata — never the archive bytes' })
  async listArchives(@TenantId() tenantId: string, @Query() query: ListArchivesQueryDto) {
    return this.archives.listArchives(tenantId, query);
  }

  @Get('archives/:jobId')
  @ApiOperation({ summary: 'Check one archive’s build status and size' })
  @ApiParam({ name: 'jobId', description: 'Archive job UUID' })
  @ApiResponse({ status: 200, description: 'Archive metadata' })
  @ApiResponse({ status: 404, description: 'No such archive for this business' })
  async getArchive(
    @TenantId() tenantId: string,
    @Param('jobId', UuidValidationPipe) jobId: string,
  ) {
    return this.archives.getArchive(tenantId, jobId);
  }

  /**
   * Download the bytes.
   *
   * POST rather than GET, and the token in the body rather than the query
   * string, because a GET with the credential in the URL puts it in the access
   * log, the browser's history and any `Referer` header the page later sends —
   * for a credential that unlocks one person's entire history with the
   * business. The cost is that it is not a link the operator can click; that is
   * the intended trade.
   */
  @Post('archives/:jobId/download')
  @TenantRateLimit('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Download a built archive' })
  @ApiParam({ name: 'jobId', description: 'Archive job UUID' })
  @ApiResponse({ status: 200, description: 'The archive, as a file attachment' })
  @ApiResponse({ status: 400, description: 'The archive is not built yet' })
  @ApiResponse({ status: 403, description: 'The archive has expired' })
  @ApiResponse({ status: 404, description: 'No such archive, or the token does not match' })
  async downloadArchive(
    @TenantId() tenantId: string,
    @Param('jobId', UuidValidationPipe) jobId: string,
    @Body() dto: DownloadArchiveDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const archive = await this.archives.downloadArchive(
      tenantId,
      jobId,
      dto.token,
      this.actorOf(user, req),
    );

    res.setHeader('Content-Type', archive.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    res.setHeader('Content-Length', String(archive.body.byteLength));
    if (archive.checksum) {
      // So the recipient can verify the transfer without a second request.
      res.setHeader('X-Archive-SHA256', archive.checksum);
    }
    // Never let a proxy or the browser keep a copy of a bulk PII disclosure.
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(archive.body);
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
