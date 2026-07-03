import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RealtyPlan } from '@gosumo/shared';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
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
  @ApiOperation({ summary: 'List the available GoSumo Realty pricing tiers' })
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

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the subscription tier' })
  @ApiResponse({ status: 200, description: 'Updated subscription usage summary' })
  async upgrade(@TenantId() tenantId: string, @Body() dto: UpgradePlanDto) {
    return this.billing.upgradePlan(tenantId, dto.plan as RealtyPlan);
  }
}
