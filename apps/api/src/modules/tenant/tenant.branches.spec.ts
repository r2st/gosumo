/**
 * TenantService — branch coverage for the sparse-patch and merge paths.
 *
 * `tenant.spec.ts` covers the lifecycle and the plan-limit rejections. What is
 * left is where the service reads or writes JSON blobs a field at a time, and
 * where those reads have a fallback:
 *
 *  - **`updateBusiness` / `updatePolicies`.** Both build a patch from an
 *    all-optional DTO and report a `changedFields` list on the emitted event.
 *    A field that is written but not reported (or reported but not written)
 *    desynchronises every downstream cache listening on that event, and
 *    nothing type-checks the pairing.
 *  - **`getAIConfig` / `getPolicies`.** Both merge stored JSON over a defaults
 *    object. A null column must fall back to the defaults rather than
 *    producing `undefined` thresholds — an undefined `autoExecuteThreshold`
 *    would make the AI confidence router compare against NaN and route
 *    everything to one path.
 *  - **`getPlanLimits`.** The unlimited sentinel is -1, which is a *smaller*
 *    number than any real count. Without the `isUnlimited` → Infinity
 *    conversion, an unlimited plan would reject at the first resource.
 *
 * The repository and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { TeamMemberRole, TeamMemberStatus } from '@gosumo/database';
import { ChannelType } from '@gosumo/shared';

import { TenantService } from './tenant.service';
import { TenantRepository } from './tenant.repository';
import { AuditLogService } from '../../common/services/audit-log.service';
import { SubscriptionTier } from './tenant.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const CHANNEL_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';

function makeBusiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    name: 'Test Shop',
    slug: 'test-shop',
    email: 'test@example.com',
    phone: '+919876543210',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    plan: 'starter',
    plan_limits: {},
    ai_settings: {},
    profile: {},
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    logo_url: null,
    website_url: null,
    ...overrides,
  };
}

function makeChannelAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHANNEL_ACCOUNT_ID,
    business_id: BUSINESS_ID,
    channel: ChannelType.WHATSAPP,
    is_active: true,
    credentials: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function createMockRepository() {
  return {
      findBusinessById: jest.fn().mockResolvedValue(makeBusiness()),
      findBusinessByEmail: jest.fn().mockResolvedValue(null),
      findBusinessBySlug: jest.fn().mockResolvedValue(null),
      createBusiness: jest.fn().mockResolvedValue(makeBusiness()),
      updateBusiness: jest.fn().mockResolvedValue(makeBusiness()),
      findChannelAccounts: jest.fn().mockResolvedValue([]),
      findChannelAccountById: jest.fn().mockResolvedValue(makeChannelAccount()),
      countChannelAccounts: jest.fn().mockResolvedValue(0),
      createChannelAccount: jest.fn().mockResolvedValue(makeChannelAccount()),
      softDeleteChannelAccount: jest.fn().mockResolvedValue(undefined),
      setChannelAccountActive: jest
        .fn()
        .mockResolvedValue(makeChannelAccount({ is_active: false })),
      findTeamMembers: jest.fn().mockResolvedValue([]),
      countTeamMembers: jest.fn().mockResolvedValue(0),
      findTeamMemberById: jest.fn().mockResolvedValue(null),
      findTeamMemberByEmail: jest.fn().mockResolvedValue(null),
      createTeamMember: jest.fn(),
      createOwnerMember: jest.fn(),
      softDeleteTeamMember: jest.fn(),
    findBusinessRules: jest.fn().mockResolvedValue([]),
  };
}

describe('TenantService (branches)', () => {
  let service: TenantService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: TenantRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
  });

  /** The payload of the first emitted event with this name. */
  function emitted(name: string): Record<string, unknown> | undefined {
    const call = eventEmitter.emit.mock.calls.find((c) => c[0] === name);
    return call?.[1] as Record<string, unknown> | undefined;
  }

  // ─────────────────────────────────────────────
  // createBusiness
  // ─────────────────────────────────────────────

  describe('createBusiness', () => {
    it('stores a supplied GST number on the profile', async () => {
      await service.createBusiness(
        {
          name: 'Test Shop',
          email: 'new@example.com',
          gstNumber: '27AAPFU0939F1ZV',
        } as never,
        OWNER_ID,
      );

      const profile = repository.createBusiness.mock.calls[0]![0].profile as Record<
        string,
        unknown
      >;
      expect(profile['gstNumber']).toBe('27AAPFU0939F1ZV');
    });

    it('omits the GST key entirely when none is supplied', async () => {
      // An explicit `undefined` in the profile JSON is not the same as absent.
      await service.createBusiness(
        { name: 'Test Shop', email: 'new@example.com' } as never,
        OWNER_ID,
      );

      const profile = repository.createBusiness.mock.calls[0]![0].profile as Record<
        string,
        unknown
      >;
      expect(profile).not.toHaveProperty('gstNumber');
      expect(profile['onboarding']).toEqual({ completedSteps: [] });
    });
  });

  // ─────────────────────────────────────────────
  // suspendBusiness
  // ─────────────────────────────────────────────

  describe('suspendBusiness', () => {
    it('suspends without a reason and still emits the event', async () => {
      await service.suspendBusiness(BUSINESS_ID, {} as never);

      expect(emitted('business.suspended')).toMatchObject({
        businessId: BUSINESS_ID,
        reason: undefined,
      });
    });
  });

  // ─────────────────────────────────────────────
  // updateBusiness — one field at a time
  // ─────────────────────────────────────────────

  describe('updateBusiness patches', () => {
    /** Patch one field and report (written patch, reported changedFields). */
    async function patchOne(
      dto: Record<string, unknown>,
    ): Promise<{ written: Record<string, unknown>; reported: string[] }> {
      await service.updateBusiness(BUSINESS_ID, dto as never);
      return {
        written: repository.updateBusiness.mock.calls[0]![1] as Record<string, unknown>,
        reported: emitted('business.settings.updated')!['changedFields'] as string[],
      };
    }

    it('writes and reports a phone change', async () => {
      const { written, reported } = await patchOne({ phone: '+919812345678' });

      expect(written).toEqual({ phone: '+919812345678' });
      expect(reported).toEqual(['phone']);
    });

    it('writes and reports a timezone change', async () => {
      const { written, reported } = await patchOne({ timezone: 'Asia/Dubai' });

      expect(written).toEqual({ timezone: 'Asia/Dubai' });
      expect(reported).toEqual(['timezone']);
    });

    it('writes and reports a currency change', async () => {
      const { written, reported } = await patchOne({ currency: 'AED' });

      expect(written).toEqual({ currency: 'AED' });
      expect(reported).toEqual(['currency']);
    });

    it('writes and reports an email change after the uniqueness check', async () => {
      const { written, reported } = await patchOne({ email: 'new@example.com' });

      expect(repository.findBusinessByEmail).toHaveBeenCalledWith('new@example.com');
      expect(written).toEqual({ email: 'new@example.com' });
      expect(reported).toEqual(['email']);
    });

    it('reports every changed field when several move at once', async () => {
      // A field written but not reported would leave downstream caches stale.
      const { written, reported } = await patchOne({
        name: 'Renamed',
        phone: '+919812345678',
        email: 'new@example.com',
        timezone: 'Asia/Dubai',
        currency: 'AED',
      });

      expect(Object.keys(written).sort()).toEqual(
        ['currency', 'email', 'name', 'phone', 'timezone'].sort(),
      );
      expect(reported.sort()).toEqual(
        ['currency', 'email', 'name', 'phone', 'timezone'].sort(),
      );
    });
  });

  // ─────────────────────────────────────────────
  // AI config
  // ─────────────────────────────────────────────

  describe('getAIConfig', () => {
    it('falls back to the defaults when the column is null', async () => {
      // An undefined threshold would make the confidence router compare
      // against NaN and send every decision down one path.
      repository.findBusinessById.mockResolvedValue(makeBusiness({ ai_settings: null }));

      const config = await service.getAIConfig(BUSINESS_ID);

      expect(config.autoExecuteThreshold).toBeGreaterThan(0);
      expect(config.reviewThreshold).toBeGreaterThan(0);
    });
  });

  describe('updateAIConfig', () => {
    /** The merged ai_settings blob the service wrote. */
    function written(): Record<string, unknown> {
      return repository.updateBusiness.mock.calls[0]![1]['ai_settings'] as Record<
        string,
        unknown
      >;
    }

    it('accepts thresholds that are exactly equal', async () => {
      // The guard is `<`, so an equal pair is the boundary that must pass.
      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.8,
        reviewThreshold: 0.8,
      } as never);

      expect(written()).toMatchObject({ autoExecuteThreshold: 0.8, reviewThreshold: 0.8 });
    });

    it('stores a supplied personality prompt', async () => {
      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.9,
        reviewThreshold: 0.7,
        personalityPrompt: 'Be brief and warm.',
      } as never);

      expect(written()).toMatchObject({ personalityPrompt: 'Be brief and warm.' });
    });

    it('stores a supplied response language', async () => {
      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.9,
        reviewThreshold: 0.7,
        responseLanguage: 'hi',
      } as never);

      expect(written()).toMatchObject({ responseLanguage: 'hi' });
    });

    it('omits the optional keys entirely when they are not supplied', async () => {
      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.9,
        reviewThreshold: 0.7,
      } as never);

      expect(written()).not.toHaveProperty('personalityPrompt');
      expect(written()).not.toHaveProperty('responseLanguage');
    });

    it('preserves unrelated stored settings through the merge', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ ai_settings: { tone: 'formal' } }),
      );

      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.9,
        reviewThreshold: 0.7,
      } as never);

      expect(written()).toMatchObject({ tone: 'formal' });
    });

    it('starts from the defaults when the column is null', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ ai_settings: null }));

      await service.updateAIConfig(BUSINESS_ID, {
        autoExecuteThreshold: 0.9,
        reviewThreshold: 0.7,
      } as never);

      expect(written()).toMatchObject({ autoExecuteThreshold: 0.9 });
    });
  });

  // ─────────────────────────────────────────────
  // Channel status
  // ─────────────────────────────────────────────

  describe('setChannelStatus', () => {
    it('pauses a channel and emits the settings event', async () => {
      const result = await service.setChannelStatus(BUSINESS_ID, CHANNEL_ACCOUNT_ID, false);

      expect(repository.setChannelAccountActive).toHaveBeenCalledWith(
        BUSINESS_ID,
        CHANNEL_ACCOUNT_ID,
        false,
      );
      expect(emitted('business.settings.updated')).toMatchObject({
        changedFields: ['channelStatus'],
      });
      expect(result).toMatchObject({ is_active: false });
    });

    it('reactivates a paused channel', async () => {
      repository.setChannelAccountActive.mockResolvedValue(
        makeChannelAccount({ is_active: true }),
      );

      await service.setChannelStatus(BUSINESS_ID, CHANNEL_ACCOUNT_ID, true);

      expect(repository.setChannelAccountActive).toHaveBeenCalledWith(
        BUSINESS_ID,
        CHANNEL_ACCOUNT_ID,
        true,
      );
    });

    it('404s and writes nothing for a channel the tenant cannot see', async () => {
      repository.findChannelAccountById.mockResolvedValue(null);

      await expect(
        service.setChannelStatus(BUSINESS_ID, CHANNEL_ACCOUNT_ID, false),
      ).rejects.toThrow(
        new NotFoundException(`Channel account not found: ${CHANNEL_ACCOUNT_ID}`),
      );
      expect(repository.setChannelAccountActive).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // Policies
  // ─────────────────────────────────────────────

  describe('getPolicies', () => {
    it('falls back to the defaults when the profile column is null', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ profile: null }));

      const policies = await service.getPolicies(BUSINESS_ID);

      expect(policies.refundWindowDays).toBeGreaterThan(0);
    });

    it('falls back to the defaults when the profile has no policies key', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { onboarding: {} } }),
      );

      const policies = await service.getPolicies(BUSINESS_ID);

      expect(policies.refundWindowDays).toBeGreaterThan(0);
    });
  });

  describe('updatePolicies patches', () => {
    /** The merged policies blob the service wrote into the profile. */
    function writtenPolicies(): Record<string, unknown> {
      const profile = repository.updateBusiness.mock.calls[0]![1]['profile'] as Record<
        string,
        unknown
      >;
      return profile['policies'] as Record<string, unknown>;
    }

    it('writes a refund window on its own', async () => {
      await service.updatePolicies(BUSINESS_ID, { refundWindowDays: 14 } as never);

      expect(writtenPolicies()).toEqual({ refundWindowDays: 14 });
    });

    it('writes a max refund amount on its own', async () => {
      await service.updatePolicies(BUSINESS_ID, { maxRefundAmountPaise: 500000 } as never);

      expect(writtenPolicies()).toEqual({ maxRefundAmountPaise: 500000 });
    });

    it('writes a first-response SLA on its own', async () => {
      await service.updatePolicies(BUSINESS_ID, { slaFirstResponseMinutes: 15 } as never);

      expect(writtenPolicies()).toEqual({ slaFirstResponseMinutes: 15 });
    });

    it('writes a resolution SLA on its own', async () => {
      await service.updatePolicies(BUSINESS_ID, { slaResolutionMinutes: 240 } as never);

      expect(writtenPolicies()).toEqual({ slaResolutionMinutes: 240 });
    });

    it('writes a max auto-discount on its own', async () => {
      await service.updatePolicies(BUSINESS_ID, { maxAutoDiscountPercent: 10 } as never);

      expect(writtenPolicies()).toEqual({ maxAutoDiscountPercent: 10 });
    });

    it('keeps a zero value rather than treating it as unset', async () => {
      // "No auto-discount allowed" is a real policy, distinct from "unset".
      await service.updatePolicies(BUSINESS_ID, { maxAutoDiscountPercent: 0 } as never);

      expect(writtenPolicies()).toEqual({ maxAutoDiscountPercent: 0 });
    });

    it('writes an empty policy object when nothing was supplied', async () => {
      await service.updatePolicies(BUSINESS_ID, {} as never);

      expect(writtenPolicies()).toEqual({});
    });

    it('preserves the rest of the profile through the merge', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ profile: { onboarding: { completedSteps: ['a'] } } }),
      );

      await service.updatePolicies(BUSINESS_ID, { refundWindowDays: 14 } as never);

      const profile = repository.updateBusiness.mock.calls[0]![1]['profile'] as Record<
        string,
        unknown
      >;
      expect(profile['onboarding']).toEqual({ completedSteps: ['a'] });
    });

    it('starts from an empty profile when the column is null', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ profile: null }));

      await service.updatePolicies(BUSINESS_ID, { refundWindowDays: 14 } as never);

      expect(writtenPolicies()).toEqual({ refundWindowDays: 14 });
    });
  });

  // ─────────────────────────────────────────────
  // Plan limits
  // ─────────────────────────────────────────────

  describe('plan limits', () => {
    it('lets an unlimited plan add team members past any finite cap', async () => {
      // The sentinel is -1, which compares as *smaller* than any real count —
      // without the Infinity conversion this would reject the first invite.
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ plan: SubscriptionTier.SCALE }),
      );
      repository.countTeamMembers.mockResolvedValue(500);
      repository.createTeamMember.mockResolvedValue({
        id: 'tm-1',
        role: TeamMemberRole.STAFF,
        status: TeamMemberStatus.INVITED,
      });

      await expect(
        service.inviteMember(BUSINESS_ID, {
          email: 'new@example.com',
          name: 'New',
          role: 'STAFF',
        } as never),
      ).resolves.toBeDefined();
    });

    it('falls back to the STARTER limits for an unrecognised plan', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'legacy-tier' }));
      repository.countTeamMembers.mockResolvedValue(3);

      await expect(
        service.inviteMember(BUSINESS_ID, {
          email: 'new@example.com',
          name: 'New',
          role: 'STAFF',
        } as never),
      ).rejects.toThrow(/maximum of 3 team member/);
    });
  });
});
