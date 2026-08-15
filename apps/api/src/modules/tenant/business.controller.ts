import { Controller, Get, Patch, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { TeamMemberRole } from '@gosumo/database';

@ApiTags('business')
@Controller('business')
export class BusinessController {
  private readonly logger = new Logger(BusinessController.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly subscriptionService: SubscriptionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current business profile' })
  @ApiResponse({ status: 200, description: 'The business profile for the authenticated user' })
  async getMe(@TenantId() businessId: string) {
    return this.tenantService.getBusinessById(businessId);
  }

  @Patch('me')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update current business profile' })
  @ApiResponse({ status: 200, description: 'The updated business profile' })
  async updateMe(@TenantId() businessId: string, @Body() dto: UpdateBusinessDto) {
    return this.tenantService.updateBusiness(businessId, dto);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get combined business settings' })
  @ApiResponse({ status: 200, description: 'The business settings' })
  async getSettings(@TenantId() businessId: string) {
    const biz = await this.prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    const aiSettings = (biz.ai_settings ?? {}) as Record<string, unknown>;
    const profile = (biz.profile ?? {}) as Record<string, unknown>;
    const settings = (profile['settings'] ?? {}) as Record<string, unknown>;
    return {
      aiAutoReplyEnabled: aiSettings.autoReplyEnabled ?? settings.aiAutoReplyEnabled ?? true,
      aiAutonomyLevel: aiSettings.autonomyLevel ?? settings.aiAutonomyLevel ?? 'BALANCED',
      defaultGreeting: aiSettings.defaultGreeting ?? settings.defaultGreeting ?? '',
      defaultSignoff: aiSettings.defaultSignoff ?? settings.defaultSignoff ?? '',
      officeHoursEnabled: settings.officeHoursEnabled ?? false,
      officeHours: settings.officeHours ?? {},
      outsideHoursMessage: settings.outsideHoursMessage ?? '',
    };
  }

  @Patch('settings')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update combined business settings' })
  @ApiResponse({ status: 200, description: 'The updated business settings' })
  async updateSettings(@TenantId() businessId: string, @Body() dto: UpdateBusinessSettingsDto) {
    // The merge is done in Postgres rather than here. Reading `profile`,
    // spreading the patch over it and writing the whole column back loses every
    // concurrent write to that column — a second manager's save, or the
    // `suspendedAt` marker `suspendBusiness` writes the same way. See
    // `TenantRepository.mergeProfileSettings`.
    //
    // `dto` is the ValidationPipe's output with `whitelist: true`, so it holds
    // only declared, supplied keys — spreading it into a `Record` cannot
    // smuggle an undeclared key into the settings object.
    return this.tenantService.updateProfileSettings(businessId, { ...dto });
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get current subscription' })
  @ApiResponse({ status: 200, description: 'The current subscription, tier and renewal date' })
  async getSubscription(@TenantId() businessId: string) {
    try {
      const sub = await this.subscriptionService.getSubscription(businessId);
      // Transform to shape the frontend billing page expects
      return {
        plan: sub.plan,
        status: sub.isActive ? 'ACTIVE' : 'INACTIVE',
        priceMonthlyPaise: sub.pricePaise ?? 0,
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
        trialEndsAt: null,
        usage: [],
      };
    } catch {
      return {
        plan: 'STARTER',
        status: 'ACTIVE',
        priceMonthlyPaise: 0,
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
        trialEndsAt: null,
        usage: [],
      };
    }
  }
}
