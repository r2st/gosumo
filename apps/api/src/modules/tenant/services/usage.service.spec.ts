import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsageService, QuotaExceededException } from './usage.service';
import { TenantRepository } from '../tenant.repository';
import { UsageMetric } from '../tenant.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-06-15T10:00:00.000Z');
const PERIOD = '2026-06';

function makeBusiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    plan: 'starter',
    is_active: true,
    profile: {},
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

describe('UsageService', () => {
  let service: UsageService;
  let repository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    repository = createMockRepository();
    repository.countChannelAccounts.mockResolvedValue(0);
    repository.countTeamMembers.mockResolvedValue(0);
    repository.updateBusiness.mockResolvedValue(makeBusiness());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: TenantRepository, useValue: repository },
      ],
    }).compile();

    service = module.get<UsageService>(UsageService);
  });

  describe('getUsage', () => {
    it('reports resource and monthly metrics against plan limits', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          plan: 'starter',
          profile: { usage: { [PERIOD]: { conversations: 250, aiResponses: 100 } } },
        }),
      );
      repository.countChannelAccounts.mockResolvedValue(1);
      repository.countTeamMembers.mockResolvedValue(2);

      const snapshot = await service.getUsage(BUSINESS_ID, NOW);

      expect(snapshot.plan).toBe('starter');
      expect(snapshot.period).toBe(PERIOD);

      const channels = snapshot.metrics.find((m) => m.metric === UsageMetric.CHANNELS)!;
      expect(channels.used).toBe(1);
      expect(channels.limit).toBe(1);
      expect(channels.remaining).toBe(0);
      expect(channels.overLimit).toBe(true);

      const conversations = snapshot.metrics.find((m) => m.metric === UsageMetric.CONVERSATIONS)!;
      expect(conversations.used).toBe(250);
      expect(conversations.limit).toBe(1000);
      expect(conversations.remaining).toBe(750);
      expect(conversations.percentUsed).toBe(25);
      expect(conversations.overLimit).toBe(false);
    });

    it('marks unlimited metrics with null remaining and 0%', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'scale' }));
      repository.countChannelAccounts.mockResolvedValue(42);

      const snapshot = await service.getUsage(BUSINESS_ID, NOW);
      const channels = snapshot.metrics.find((m) => m.metric === UsageMetric.CHANNELS)!;

      expect(channels.limit).toBe(-1);
      expect(channels.remaining).toBeNull();
      expect(channels.percentUsed).toBe(0);
      expect(channels.overLimit).toBe(false);
    });
  });

  describe('assertWithinQuota', () => {
    it('passes when usage is below the limit', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { conversations: 10 } } } }),
      );

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, NOW),
      ).resolves.toBeUndefined();
    });

    it('throws QuotaExceededException (402) when the limit would be exceeded', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { conversations: 1000 } } } }),
      );

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, NOW),
      ).rejects.toBeInstanceOf(QuotaExceededException);
    });

    it('uses a user-friendly label in the quota message', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { conversations: 1000 } } } }),
      );

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, NOW),
      ).rejects.toThrow(/conversations this month/);
    });

    it('enforces resource quotas from live counts', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countChannelAccounts.mockResolvedValue(1); // starter limit = 1

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CHANNELS, 1, NOW),
      ).rejects.toBeInstanceOf(QuotaExceededException);
    });

    it('never throws for unlimited plans', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'enterprise' }));
      repository.countChannelAccounts.mockResolvedValue(999);

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CHANNELS, 5, NOW),
      ).resolves.toBeUndefined();
    });
  });

  describe('hasQuota', () => {
    it('returns false instead of throwing when over quota', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { campaigns: 5 } } } }),
      );
      const ok = await service.hasQuota(BUSINESS_ID, UsageMetric.CAMPAIGNS, 1, NOW);
      expect(ok).toBe(false);
    });
  });

  describe('incrementUsage', () => {
    it('increments a monthly counter within the current period', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { conversations: 4 } } } }),
      );

      const next = await service.incrementUsage(BUSINESS_ID, UsageMetric.CONVERSATIONS, 2, NOW);

      expect(next).toBe(6);
      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            usage: { [PERIOD]: { conversations: 6 } },
          }),
        }),
      );
    });

    it('starts a fresh counter when the period bucket is empty', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ profile: {} }));

      const next = await service.incrementUsage(BUSINESS_ID, UsageMetric.AI_RESPONSES, 1, NOW);
      expect(next).toBe(1);
    });

    it('rejects recording a resource metric directly', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      await expect(
        service.incrementUsage(BUSINESS_ID, UsageMetric.CHANNELS, 1, NOW),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive amount', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      await expect(
        service.incrementUsage(BUSINESS_ID, UsageMetric.CONVERSATIONS, 0, NOW),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for a missing business', async () => {
      repository.findBusinessById.mockResolvedValue(null);
      await expect(
        service.incrementUsage(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, NOW),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resetMonthlyUsage', () => {
    it('clears the current period bucket', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { usage: { [PERIOD]: { conversations: 9 }, '2026-05': { conversations: 3 } } } }),
      );

      await service.resetMonthlyUsage(BUSINESS_ID, NOW);

      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            usage: { '2026-05': { conversations: 3 } },
          }),
        }),
      );
    });
  });
});
