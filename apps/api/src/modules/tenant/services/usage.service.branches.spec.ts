/**
 * UsageService — the default-argument and empty-counter branches.
 *
 * Every public method takes `now` (and most take an amount) with a default, and
 * the existing spec always passes them explicitly to keep assertions
 * deterministic. That leaves the production call shape — the one every caller
 * actually uses — untested, so it is pinned here against a faked clock.
 *
 * The other gap is the "no counter yet" case. A business in its first month has
 * no `profile.usage[period]` bucket at all, so every monthly metric reads
 * through a `?? 0` fallback. That is the state every new tenant is in, and it
 * is the state in which a quota check must still return a usable answer rather
 * than NaN.
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsageService, QuotaExceededException } from './usage.service';
import { TenantRepository } from '../tenant.repository';
import { UsageMetric } from '../tenant.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const FAKE_NOW = new Date('2026-08-10T12:00:00Z');

describe('UsageService — branches', () => {
  let service: UsageService;
  let repository: {
    findBusinessById: jest.Mock;
    updateBusiness: jest.Mock;
    countChannelAccounts: jest.Mock;
    countTeamMembers: jest.Mock;
  };

  function business(overrides: Record<string, unknown> = {}) {
    return {
      id: BUSINESS_ID,
      plan: 'free',
      profile: {},
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FAKE_NOW);

    repository = {
      findBusinessById: jest.fn().mockResolvedValue(business()),
      updateBusiness: jest.fn().mockResolvedValue(undefined),
      countChannelAccounts: jest.fn().mockResolvedValue(0),
      countTeamMembers: jest.fn().mockResolvedValue(0),
    };

    service = new UsageService(repository as unknown as TenantRepository);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('default clock', () => {
    it('getUsage buckets against the current month when no clock is passed', async () => {
      const snapshot = await service.getUsage(BUSINESS_ID);

      expect(snapshot.period).toBe('2026-08');
      expect(snapshot.plan).toBe('free');
      expect(snapshot.metrics.length).toBeGreaterThan(0);
    });

    it('assertWithinQuota defaults to requesting a single unit now', async () => {
      repository.countChannelAccounts.mockResolvedValue(0);

      await expect(
        service.assertWithinQuota(BUSINESS_ID, UsageMetric.CHANNELS),
      ).resolves.toBeUndefined();
    });

    it('hasQuota defaults to a single unit now', async () => {
      await expect(
        service.hasQuota(BUSINESS_ID, UsageMetric.CHANNELS),
      ).resolves.toBe(true);
    });

    it('incrementUsage defaults to +1 in the current period', async () => {
      const next = await service.incrementUsage(
        BUSINESS_ID,
        UsageMetric.CONVERSATIONS,
      );

      expect(next).toBe(1);
      const { profile } = repository.updateBusiness.mock.calls[0]![1];
      expect(profile.usage['2026-08'][UsageMetric.CONVERSATIONS]).toBe(1);
    });

    it('resetMonthlyUsage clears the current period when no clock is passed', async () => {
      repository.findBusinessById.mockResolvedValue(
        business({
          profile: {
            usage: {
              '2026-08': { [UsageMetric.CONVERSATIONS]: 12 },
              '2026-07': { [UsageMetric.CONVERSATIONS]: 90 },
            },
          },
        }),
      );

      await service.resetMonthlyUsage(BUSINESS_ID);

      const { profile } = repository.updateBusiness.mock.calls[0]![1];
      expect(profile.usage).not.toHaveProperty('2026-08');
      // Prior months are history — the reset must not touch them.
      expect(profile.usage['2026-07']).toEqual({
        [UsageMetric.CONVERSATIONS]: 90,
      });
    });
  });

  describe('a tenant with no counters yet', () => {
    it('reports zero usage for every monthly metric', async () => {
      const snapshot = await service.getUsage(BUSINESS_ID, FAKE_NOW);

      for (const metric of snapshot.metrics) {
        expect(metric.used).toBe(0);
        expect(Number.isNaN(metric.percentUsed)).toBe(false);
      }
    });

    it('treats a missing monthly counter as zero when checking quota', async () => {
      await expect(
        service.hasQuota(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, FAKE_NOW),
      ).resolves.toBe(true);
    });

    it('ignores a non-numeric stored counter rather than trusting it', async () => {
      repository.findBusinessById.mockResolvedValue(
        business({
          profile: {
            usage: { '2026-08': { [UsageMetric.CONVERSATIONS]: 'lots' } },
          },
        }),
      );

      const snapshot = await service.getUsage(BUSINESS_ID, FAKE_NOW);
      const conversations = snapshot.metrics.find(
        (m) => m.metric === UsageMetric.CONVERSATIONS,
      );

      expect(conversations?.used).toBe(0);
    });

    it('starts the counter from zero when incrementing over a non-numeric value', async () => {
      repository.findBusinessById.mockResolvedValue(
        business({
          profile: {
            usage: { '2026-08': { [UsageMetric.CONVERSATIONS]: null } },
          },
        }),
      );

      const next = await service.incrementUsage(
        BUSINESS_ID,
        UsageMetric.CONVERSATIONS,
        5,
        FAKE_NOW,
      );

      expect(next).toBe(5);
    });

    it('rebuilds the profile when profile.usage is not an object', async () => {
      repository.findBusinessById.mockResolvedValue(
        business({ profile: { usage: 'corrupted' } }),
      );

      const next = await service.incrementUsage(
        BUSINESS_ID,
        UsageMetric.CONVERSATIONS,
        1,
        FAKE_NOW,
      );

      expect(next).toBe(1);
      const { profile } = repository.updateBusiness.mock.calls[0]![1];
      expect(profile.usage['2026-08'][UsageMetric.CONVERSATIONS]).toBe(1);
    });
  });

  describe('resource metrics', () => {
    it('reads live row counts rather than stored counters', async () => {
      repository.countChannelAccounts.mockResolvedValue(3);
      repository.countTeamMembers.mockResolvedValue(7);

      const snapshot = await service.getUsage(BUSINESS_ID, FAKE_NOW);

      expect(
        snapshot.metrics.find((m) => m.metric === UsageMetric.CHANNELS)?.used,
      ).toBe(3);
      expect(
        snapshot.metrics.find((m) => m.metric === UsageMetric.TEAM_MEMBERS)
          ?.used,
      ).toBe(7);
    });

    it('checks a resource quota against the live count, not the profile', async () => {
      repository.countChannelAccounts.mockResolvedValue(999);

      await expect(
        service.hasQuota(BUSINESS_ID, UsageMetric.CHANNELS, 1, FAKE_NOW),
      ).resolves.toBe(false);
    });
  });

  describe('rejections', () => {
    it('throws NotFound for an unknown business', async () => {
      repository.findBusinessById.mockResolvedValue(null);

      await expect(service.getUsage(BUSINESS_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to record a resource metric directly', async () => {
      await expect(
        service.incrementUsage(BUSINESS_ID, UsageMetric.CHANNELS, 1, FAKE_NOW),
      ).rejects.toThrow(BadRequestException);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
    });

    it('refuses a non-positive increment', async () => {
      await expect(
        service.incrementUsage(
          BUSINESS_ID,
          UsageMetric.CONVERSATIONS,
          0,
          FAKE_NOW,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('lets a non-quota error escape hasQuota rather than reporting false', async () => {
      repository.findBusinessById.mockRejectedValue(new Error('db down'));

      await expect(
        service.hasQuota(BUSINESS_ID, UsageMetric.CONVERSATIONS, 1, FAKE_NOW),
      ).rejects.toThrow('db down');
    });

    it('reports false — not a throw — when the quota is genuinely exhausted', async () => {
      repository.countChannelAccounts.mockResolvedValue(999);

      await expect(
        service.hasQuota(BUSINESS_ID, UsageMetric.CHANNELS, 1, FAKE_NOW),
      ).resolves.toBe(false);
      await expect(
        service.assertWithinQuota(
          BUSINESS_ID,
          UsageMetric.CHANNELS,
          1,
          FAKE_NOW,
        ),
      ).rejects.toThrow(QuotaExceededException);
    });
  });
});
