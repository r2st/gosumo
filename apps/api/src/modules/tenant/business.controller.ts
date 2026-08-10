import { Controller, Get, Patch, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { PrismaService } from '../../common/services/prisma.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateBusinessSettingsDto } from './dto/update-business-settings.dto';

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
  @ApiResponse({ status: 200 })
  async getMe(@TenantId() businessId: string) {
    return this.tenantService.getBusinessById(businessId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current business profile' })
  @ApiResponse({ status: 200 })
  async updateMe(@TenantId() businessId: string, @Body() dto: UpdateBusinessDto) {
    return this.tenantService.updateBusiness(businessId, dto);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get combined business settings' })
  @ApiResponse({ status: 200 })
  async getSettings(@TenantId() businessId: string) {
    const biz = await this.prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    const aiSettings = (biz.ai_settings ?? {}) as Record<string, any>;
    const profile = (biz.profile ?? {}) as Record<string, any>;
    const settings = profile.settings ?? {};
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
  @ApiOperation({ summary: 'Update combined business settings' })
  @ApiResponse({ status: 200 })
  async updateSettings(@TenantId() businessId: string, @Body() dto: UpdateBusinessSettingsDto) {
    const biz = await this.prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
    const profile = (biz.profile ?? {}) as Record<string, any>;
    const settings = profile.settings ?? {};
    const merged = { ...settings, ...dto };
    await this.prisma.businesses.update({
      where: { id: businessId },
      data: { profile: { ...profile, settings: merged } as any },
    });
    return merged;
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get current subscription' })
  @ApiResponse({ status: 200 })
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
