import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RealtyPlan } from '@gosumo/shared';
import { TeamMemberRole } from '@gosumo/database';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { TenantRateLimit } from '../../common/rate-limit/tenant-rate-limit.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { BillingService } from './billing.service';
import { PLAN_DEFINITIONS } from './billing.constants';
import { UpgradePlanDto } from './dto';

/**
 * BillingController — the subscription + usage surface for Settings › Billing.
 * All routes are JWT-guarded globally; @TenantId() supplies the scoped businessId.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List the available DoAide Desk pricing tiers' })
  @ApiResponse({ status: 200, description: 'Plan catalogue' })
  plans() {
    return { plans: Object.values(PLAN_DEFINITIONS) };
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Current subscription + usage summary' })
  @ApiResponse({ status: 200, description: 'Subscription usage summary' })
  async subscription(@TenantId() tenantId: string) {
    return this.billing.getUsageSummary(tenantId);
  }

  // Reading the catalogue and the current usage is open to any member — the
  // billing page has to render for whoever opens it. Changing the tier moves
  // money and is the owner's decision alone.
  @Post('upgrade')
  @Roles(TeamMemberRole.OWNER)
  @TenantRateLimit('billing-change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the subscription tier' })
  @ApiResponse({ status: 200, description: 'Updated subscription usage summary' })
  @ApiResponse({ status: 403, description: 'Only an owner may change the subscription tier' })
  async upgrade(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpgradePlanDto,
  ) {
    return this.billing.upgradePlan(tenantId, dto.plan as RealtyPlan, new Date(), {
      id: user.sub,
      email: user.email ?? null,
    });
  }
}
