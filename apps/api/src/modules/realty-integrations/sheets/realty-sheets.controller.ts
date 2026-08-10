import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { SheetsExportService } from './sheets-export.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { Public } from '../../../common/decorators/public.decorator';

/**
 * RealtySheetsController — the settings-UI surface for the Google Sheets export
 * integration: start/complete OAuth, check status, one-click export, disconnect.
 * All routes JWT-guarded except the OAuth callback (a browser redirect from
 * Google that authenticates via the signed `state`).
 */
@ApiTags('realty-integrations')
@Controller('realty/integrations/sheets')
export class RealtySheetsController {
  constructor(
    private readonly sheets: SheetsExportService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Google Sheets connection status' })
  async status(@TenantId() tenantId: string) {
    return this.sheets.getStatus(tenantId);
  }

  @Get('connect')
  @ApiOperation({ summary: 'Get the Google OAuth consent URL to connect Sheets' })
  async connect(@TenantId() tenantId: string) {
    return { authUrl: this.sheets.getAuthUrl(tenantId) };
  }

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'Google OAuth redirect callback (browser)' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({
    name: 'state',
    required: true,
    description: 'Signed state token minted by GET /connect',
  })
  @ApiResponse({ status: 302, description: 'Redirects back to the dashboard settings page' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }
    // `state` is attacker-supplied on a @Public() route — it names the tenant
    // the credentials get written against, so it is verified, never trusted.
    const businessId = this.sheets.resolveOAuthState(state);
    await this.sheets.completeOAuth(businessId, code);
    const dashboardUrl = this.config.get<string>(
      'DASHBOARD_URL',
      'https://gosumo.aiknol.com',
    );
    res.redirect(`${dashboardUrl}/settings/integrations?sheets=connected`);
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'One-click export of leads + inventory to Google Sheets' })
  async exportNow(@TenantId() tenantId: string) {
    return this.sheets.exportForBusiness(tenantId, false);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect Google Sheets' })
  async disconnect(@TenantId() tenantId: string): Promise<void> {
    await this.sheets.disconnect(tenantId);
  }
}
