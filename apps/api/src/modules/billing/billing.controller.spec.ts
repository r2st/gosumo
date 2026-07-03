/**
 * BillingController unit tests — the Settings › Billing surface.
 *
 * Coverage: plan catalogue listing, subscription usage summary, and tier upgrade.
 * BillingService is mocked; the controller only validates delegation + shaping.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { RealtyPlan } from '@gosumo/shared';

import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PLAN_DEFINITIONS } from './billing.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

describe('BillingController', () => {
  let controller: BillingController;
  let billing: jest.Mocked<Pick<BillingService, 'getUsageSummary' | 'upgradePlan'>>;

  beforeEach(async () => {
    const mockBilling = {
      getUsageSummary: jest.fn(),
      upgradePlan: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: mockBilling }],
    }).compile();

    controller = module.get(BillingController);
    billing = module.get(BillingService) as unknown as jest.Mocked<
      Pick<BillingService, 'getUsageSummary' | 'upgradePlan'>
    >;
    jest.clearAllMocks();
  });

  it('lists the full plan catalogue', () => {
    const result = controller.plans();
    expect(result.plans).toEqual(Object.values(PLAN_DEFINITIONS));
    expect(result.plans).toHaveLength(3);
  });

  it('returns the current subscription usage summary for the tenant', async () => {
    const summary = { plan: RealtyPlan.SOLO } as never;
    billing.getUsageSummary.mockResolvedValue(summary);

    const result = await controller.subscription(BUSINESS_ID);

    expect(billing.getUsageSummary).toHaveBeenCalledWith(BUSINESS_ID);
    expect(result).toBe(summary);
  });

  it('upgrades the subscription to the requested tier', async () => {
    const summary = { plan: RealtyPlan.TEAM } as never;
    billing.upgradePlan.mockResolvedValue(summary);

    const result = await controller.upgrade(BUSINESS_ID, { plan: RealtyPlan.TEAM });

    expect(billing.upgradePlan).toHaveBeenCalledWith(BUSINESS_ID, RealtyPlan.TEAM);
    expect(result).toBe(summary);
  });
});
