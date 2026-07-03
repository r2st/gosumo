/**
 * BillingRepository unit tests — Prisma access for `business_subscriptions`.
 *
 * Coverage: find/create/update field mapping (camelCase DTO → snake_case columns,
 * with only provided fields written), atomic usage increment, and the live seat
 * count (non-deleted team members). PrismaService is mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { RealtyPlan } from '@prisma/client';

import { BillingRepository } from './billing.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

describe('BillingRepository', () => {
  let repository: BillingRepository;
  let prisma: {
    business_subscriptions: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    team_members: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      business_subscriptions: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      team_members: { count: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(BillingRepository);
    jest.clearAllMocks();
  });

  it('finds a subscription by business_id', async () => {
    prisma.business_subscriptions.findUnique.mockResolvedValue({ id: 'sub' });
    await repository.findByBusiness(BUSINESS_ID);
    expect(prisma.business_subscriptions.findUnique).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID },
    });
  });

  it('creates a subscription mapping camelCase fields to snake_case columns', async () => {
    prisma.business_subscriptions.create.mockResolvedValue({ id: 'sub' });
    const start = new Date('2026-07-01T00:00:00Z');

    await repository.create({
      businessId: BUSINESS_ID,
      plan: RealtyPlan.SOLO,
      monthlyLeadLimit: 300,
      seatLimit: 1,
      planPricePaise: 399900,
      overageRatePaise: 800,
      billingCycleStart: start,
    });

    expect(prisma.business_subscriptions.create).toHaveBeenCalledWith({
      data: {
        business_id: BUSINESS_ID,
        plan: RealtyPlan.SOLO,
        monthly_lead_limit: 300,
        seat_limit: 1,
        plan_price_paise: 399900,
        overage_rate_paise: 800,
        billing_cycle_start: start,
      },
    });
  });

  it('writes only the provided fields on update', async () => {
    prisma.business_subscriptions.update.mockResolvedValue({ id: 'sub' });

    await repository.update(BUSINESS_ID, { plan: RealtyPlan.TEAM, seatLimit: 5 });

    expect(prisma.business_subscriptions.update).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID },
      data: { plan: RealtyPlan.TEAM, seat_limit: 5 },
    });
  });

  it('maps every updatable field, including a null limit and metadata', async () => {
    prisma.business_subscriptions.update.mockResolvedValue({ id: 'sub' });
    const start = new Date('2026-08-01T00:00:00Z');

    await repository.update(BUSINESS_ID, {
      plan: RealtyPlan.DEVELOPER,
      monthlyLeadLimit: null,
      seatLimit: null,
      planPricePaise: 2499900,
      overageRatePaise: 800,
      billingCycleStart: start,
      leadsUsedThisCycle: 0,
      overageLeadsThisCycle: 0,
      metadata: { hardCap: true },
    });

    expect(prisma.business_subscriptions.update).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID },
      data: {
        plan: RealtyPlan.DEVELOPER,
        monthly_lead_limit: null,
        seat_limit: null,
        plan_price_paise: 2499900,
        overage_rate_paise: 800,
        billing_cycle_start: start,
        leads_used_this_cycle: 0,
        overage_leads_this_cycle: 0,
        metadata: { hardCap: true },
      },
    });
  });

  it('sends nothing but the where clause when the update is empty', async () => {
    prisma.business_subscriptions.update.mockResolvedValue({ id: 'sub' });
    await repository.update(BUSINESS_ID, {});
    expect(prisma.business_subscriptions.update).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID },
      data: {},
    });
  });

  it('atomically increments the cycle lead + overage counters', async () => {
    prisma.business_subscriptions.update.mockResolvedValue({ id: 'sub' });

    await repository.incrementUsage(BUSINESS_ID, 1, 1);

    expect(prisma.business_subscriptions.update).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID },
      data: {
        leads_used_this_cycle: { increment: 1 },
        overage_leads_this_cycle: { increment: 1 },
      },
    });
  });

  it('counts only active (non-deleted) team members as seats', async () => {
    prisma.team_members.count.mockResolvedValue(3);

    const seats = await repository.countSeats(BUSINESS_ID);

    expect(seats).toBe(3);
    expect(prisma.team_members.count).toHaveBeenCalledWith({
      where: { business_id: BUSINESS_ID, deleted_at: null },
    });
  });
});
