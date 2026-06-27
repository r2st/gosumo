import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { TenantRepository } from '../tenant.repository';
import { SubscriptionTier } from '../tenant.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';

function makeBusiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    name: 'Test Shop',
    plan: 'starter',
    is_active: true,
    profile: {},
    plan_limits: {},
    ai_settings: {},
    deleted_at: null,
    ...overrides,
  };
}

function createMockRepository() {
  return {
    findBusinessById: jest.fn(),
    updateBusiness: jest.fn(),
    countChannelAccounts: jest.fn(),
    countTeamMembers: jest.fn(),
  };
}

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: TenantRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<SubscriptionService>(SubscriptionService);
  });

  describe('getPlanCatalog', () => {
    it('returns all five tiers', () => {
      const catalog = service.getPlanCatalog();
      const ids = catalog.map((p) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          SubscriptionTier.FREE,
          SubscriptionTier.STARTER,
          SubscriptionTier.GROWTH,
          SubscriptionTier.SCALE,
          SubscriptionTier.ENTERPRISE,
        ]),
      );
      expect(catalog).toHaveLength(5);
    });
  });

  describe('getSubscription', () => {
    it('returns the resolved plan for the business', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'growth' }));

      const sub = await service.getSubscription(BUSINESS_ID);

      expect(sub.plan).toBe(SubscriptionTier.GROWTH);
      expect(sub.limits.maxChannels).toBe(5);
      expect(sub.isActive).toBe(true);
      expect(sub.features).toContain('multi_channel');
    });

    it('throws NotFoundException when business is missing', async () => {
      repository.findBusinessById.mockResolvedValue(null);
      await expect(service.getSubscription(BUSINESS_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('changePlan', () => {
    it('upgrades and persists the new plan + limits, emits event', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countChannelAccounts.mockResolvedValue(1);
      repository.countTeamMembers.mockResolvedValue(2);
      repository.updateBusiness.mockResolvedValue(makeBusiness({ plan: 'growth' }));

      const result = await service.changePlan(BUSINESS_ID, { plan: SubscriptionTier.GROWTH });

      expect(result.plan).toBe(SubscriptionTier.GROWTH);
      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          plan: 'growth',
          plan_limits: expect.objectContaining({ maxChannels: 5, maxTeamMembers: 10 }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.plan.changed',
        expect.objectContaining({ businessId: BUSINESS_ID, fromPlan: 'starter', toPlan: 'growth' }),
      );
    });

    it('is a no-op when the target plan equals the current plan', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));

      const result = await service.changePlan(BUSINESS_ID, { plan: SubscriptionTier.STARTER });

      expect(result.plan).toBe(SubscriptionTier.STARTER);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('blocks a downgrade when current channel usage exceeds the target', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'growth' }));
      repository.countChannelAccounts.mockResolvedValue(3); // starter allows 1
      repository.countTeamMembers.mockResolvedValue(1);

      await expect(
        service.changePlan(BUSINESS_ID, { plan: SubscriptionTier.STARTER }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
    });

    it('blocks a downgrade when current team size exceeds the target', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'growth' }));
      repository.countChannelAccounts.mockResolvedValue(1);
      repository.countTeamMembers.mockResolvedValue(8); // starter allows 3

      await expect(
        service.changePlan(BUSINESS_ID, { plan: SubscriptionTier.STARTER }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows a downgrade to an unlimited tier regardless of usage', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'enterprise' }));
      repository.countChannelAccounts.mockResolvedValue(50);
      repository.countTeamMembers.mockResolvedValue(99);
      repository.updateBusiness.mockResolvedValue(makeBusiness({ plan: 'scale' }));

      const result = await service.changePlan(BUSINESS_ID, { plan: SubscriptionTier.SCALE });
      expect(result.plan).toBe(SubscriptionTier.SCALE);
    });
  });
});
