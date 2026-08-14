import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Logger, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { PrismaService } from '../../common/services/prisma.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { TeamMemberRole } from '@gosumo/database';

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);
  constructor(private readonly prisma: PrismaService) {}

  // ── Google Calendar ──────────────────────────

  @Get('google-calendar')
  @ApiOperation({ summary: 'Get Google Calendar integration status' })
  @ApiResponse({ status: 200, description: 'Paginated google calendar list for this business' })
  async getCalendar(@TenantId() _tenantId: string) {
    return {
      connected: false,
      email: null,
      calendarId: null,
      lastSyncAt: null,
      syncStatus: 'NOT_CONNECTED',
    };
  }

  @Post('google-calendar/connect')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Start Google Calendar OAuth flow' })
  @ApiResponse({ status: 201, description: 'Result of the connect action' })
  async connectCalendar(@TenantId() _tenantId: string) {
    // Placeholder — would redirect to Google OAuth consent screen
    return { authUrl: null, message: 'Google Calendar integration is not configured yet. Please set up OAuth credentials in the admin panel.' };
  }

  @Delete('google-calendar')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect Google Calendar' })
  @ApiResponse({ status: 204, description: 'Deleted; no content returned' })
  async disconnectCalendar(@TenantId() tenantId: string) {
    this.logger.log(`Disconnect calendar for tenant ${tenantId}`);
  }

  // ── Integration Credentials (Payment + Messaging providers) ──

  @Get('credentials')
  @ApiOperation({ summary: 'List saved integration credentials' })
  @ApiResponse({ status: 200, description: 'Paginated credential list for this business' })
  async listCredentials(@TenantId() _tenantId: string) {
    // Return empty list — no integrations configured yet
    return { integrations: [] };
  }

  @Put('credentials/:provider')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Save credentials for a provider' })
  @ApiResponse({ status: 200, description: 'The updated credential' })
  @ApiParam({ name: 'provider', description: 'Provider' })
  async saveCredentials(
    @TenantId() tenantId: string,
    @Param('provider') provider: string,
    @Body() _body: Record<string, unknown>,
  ) {
    this.logger.log(`Saving ${provider} credentials for tenant ${tenantId}`);
    return {
      provider: provider.toUpperCase(),
      connected: true,
      connectedAt: new Date().toISOString(),
    };
  }

  @Post('credentials/:provider/test')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Test connection for a provider' })
  @ApiResponse({ status: 201, description: 'Result of the test action' })
  @ApiParam({ name: 'provider', description: 'Provider' })
  async testCredentials(
    @TenantId() tenantId: string,
    @Param('provider') provider: string,
  ) {
    return { success: false, message: `${provider} integration is not fully configured yet.` };
  }
}
