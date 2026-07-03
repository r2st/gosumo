import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyIvrService } from './realty-ivr.service';
import { parseIvrCallback } from './ivr/ivr-callback.parser';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CsvImportDto, PortalEmailDto, CtwaContextDto } from './dto';

/**
 * RealtyIngestionController — the ingress surface for external lead sources.
 *
 * Webhook routes (Meta Leadgen, portal email) are `@Public()` and do their own
 * verification (HMAC / shared secret), mirroring the channel-adapter webhooks.
 * They always answer 200 fast so providers don't retry; processing is
 * best-effort. `businessId` on webhooks is resolved from the `x-business-id`
 * header set by the API gateway (same convention as channel-adapter).
 *
 * Authenticated routes (CSV import, CTWA) use `@TenantId()`.
 */
@ApiTags('realty-ingestion')
@Controller()
export class RealtyIngestionController {
  private readonly logger = new Logger(RealtyIngestionController.name);

  constructor(
    private readonly ingestionService: RealtyIngestionService,
    private readonly ivrService: RealtyIvrService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // IVR missed-call → WhatsApp webhook
  // ─────────────────────────────────────────────

  @Public()
  @Post('realty/ingestion/ivr-callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'IVR missed-call webhook (Exotel / Knowlarity / generic) → WhatsApp' })
  @ApiResponse({ status: 200, description: 'Acknowledged' })
  async handleIvrCallback(
    @Req() req: Request,
    @Headers('x-ivr-signature') signature: string,
    @Headers('x-business-id') businessId: string,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!this.ivrService.verifyIvrSignature(rawBody, signature)) {
      // Invalid signature: log + discard, but still 200 so the provider does
      // not enter a retry storm (channel-adapter convention).
      this.logger.warn('IVR webhook rejected: invalid signature');
      return { status: 'ok' };
    }
    try {
      const call = parseIvrCallback(body);
      if (!call) {
        this.logger.warn('IVR webhook payload had no caller phone — ignoring');
        return { status: 'ok' };
      }
      await this.ivrService.processIvrCallback(businessId ?? 'unknown', call);
    } catch (err) {
      this.logger.error(
        `Error processing IVR callback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Meta Leadgen webhook
  // ─────────────────────────────────────────────

  @Public()
  @Get('webhooks/realty/meta-leadgen')
  @ApiOperation({ summary: 'Meta Leadgen webhook verification challenge' })
  @ApiQuery({ name: 'hub.mode', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true })
  @ApiQuery({ name: 'hub.verify_token', required: false })
  handleLeadgenVerification(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const result = this.ingestionService.resolveMetaChallenge(mode, verifyToken, challenge);
    if (result !== null) {
      res.status(HttpStatus.OK).send(result);
      return;
    }
    res.status(HttpStatus.FORBIDDEN).json({ message: 'Verification failed' });
  }

  @Public()
  @Post('webhooks/realty/meta-leadgen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Meta Leadgen inbound webhook (Facebook/Instagram Lead Ads)' })
  @ApiResponse({ status: 200, description: 'Acknowledged' })
  async handleLeadgenWebhook(
    @Req() req: Request,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-business-id') businessId: string,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!this.ingestionService.verifyMetaSignature(rawBody, signature)) {
      // Invalid signature: log + discard, but still 200 to avoid Meta retries.
      this.logger.warn('Meta Leadgen webhook rejected: invalid signature');
      return { status: 'ok' };
    }
    try {
      const tenant = businessId ?? 'unknown';
      await this.ingestionService.ingestMetaLeadgen(tenant, body);
    } catch (err) {
      this.logger.error(
        `Error processing Meta Leadgen webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // Portal enquiry email webhook
  // ─────────────────────────────────────────────

  @Public()
  @Post('webhooks/realty/portal-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Property-portal enquiry email webhook (99acres/MagicBricks/Housing)' })
  @ApiResponse({ status: 200, description: 'Acknowledged' })
  @ApiResponse({ status: 401, description: 'Invalid ingest token' })
  async handlePortalEmail(
    @Headers('x-portal-token') token: string,
    @Headers('x-business-id') businessId: string,
    @Body() dto: PortalEmailDto,
  ): Promise<{ status: string }> {
    const expected = this.configService.get<string>('realty.portalIngestToken', '');
    if (expected) {
      if (token !== expected) {
        throw new UnauthorizedException('Invalid portal ingest token');
      }
    } else {
      this.logger.warn('Portal ingest token not configured — accepting without verification');
    }
    try {
      await this.ingestionService.ingestPortalEmail(businessId ?? 'unknown', dto);
    } catch (err) {
      this.logger.error(
        `Error processing portal email: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { status: 'ok' };
  }

  // ─────────────────────────────────────────────
  // CSV bulk import (authenticated)
  // ─────────────────────────────────────────────

  @Post('realty/ingestion/csv')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-import leads from parsed CSV rows (E.164 identity merge)' })
  @ApiResponse({ status: 200, description: 'Import summary' })
  async importCsv(@TenantId() tenantId: string, @Body() dto: CsvImportDto) {
    return this.ingestionService.importCsv(tenantId, dto);
  }

  // ─────────────────────────────────────────────
  // CTWA context (authenticated — called by channel-adapter on referral)
  // ─────────────────────────────────────────────

  @Post('realty/ingestion/ctwa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach Click-to-WhatsApp ad context to a lead' })
  @ApiResponse({ status: 200, description: 'Lead ingested/merged' })
  async ingestCtwa(@TenantId() tenantId: string, @Body() dto: CtwaContextDto) {
    return this.ingestionService.ingestCtwa(tenantId, dto);
  }
}
