import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { TeamMemberRole, TeamMemberStatus } from '@gosumo/database';
import { TenantService } from './tenant.service';
import { TenantRepository } from './tenant.repository';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateAIConfigDto } from './dto/ai-config.dto';
import { ConnectChannelDto } from './dto/connect-channel.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateBusinessPoliciesDto } from './dto/business-policies.dto';
import { ChannelType, TeamRole } from '@gosumo/shared';
import { SubscriptionTier } from './tenant.constants';

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';
const CHANNEL_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';

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

function makeTeamMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEMBER_ID,
    business_id: BUSINESS_ID,
    email: 'member@example.com',
    name: 'Staff Person',
    role: TeamMemberRole.STAFF,
    status: TeamMemberStatus.ACTIVE,
    phone: null,
    avatar_url: null,
    password_hash: null,
    totp_secret: null,
    last_login_at: null,
    login_count: 0,
    notification_prefs: {},
    invite_token: null,
    invited_by: null,
    invited_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function makeChannelAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CHANNEL_ACCOUNT_ID,
    business_id: BUSINESS_ID,
    channel: 'WHATSAPP',
    name: 'Main WhatsApp',
    is_primary: false,
    external_id: '1234567890',
    external_account: null,
    credentials: {},
    webhook_url: null,
    webhook_secret: null,
    is_active: true,
    is_verified: false,
    capabilities: {},
    message_limit_per_day: null,
    messages_sent_today: 0,
    limit_reset_at: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Mock repository
// ─────────────────────────────────────────────

function createMockRepository() {
  return {
    findBusinessById: jest.fn(),
    findBusinessByEmail: jest.fn(),
    findBusinessBySlug: jest.fn(),
    createBusiness: jest.fn(),
    updateBusiness: jest.fn(),
    findChannelAccounts: jest.fn(),
    findChannelAccountById: jest.fn(),
    countChannelAccounts: jest.fn(),
    createChannelAccount: jest.fn(),
    softDeleteChannelAccount: jest.fn(),
    findTeamMembers: jest.fn(),
    countTeamMembers: jest.fn(),
    findTeamMemberById: jest.fn(),
    findTeamMemberByEmail: jest.fn(),
    createTeamMember: jest.fn(),
    createOwnerMember: jest.fn(),
    softDeleteTeamMember: jest.fn(),
    findBusinessRules: jest.fn(),
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('TenantService', () => {
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
      ],
    }).compile();

    service = module.get<TenantService>(TenantService);
  });

  // ─── Business Lifecycle ──────────────────────

  describe('createBusiness', () => {
    it('creates a business with a unique slug and founding owner, emits event', async () => {
      const created = makeBusiness({ name: "Priya's Boutique", slug: 'priyas-boutique' });
      repository.findBusinessByEmail.mockResolvedValue(null);
      repository.findBusinessBySlug.mockResolvedValue(null);
      repository.createBusiness.mockResolvedValue(created);
      repository.createOwnerMember.mockResolvedValue(makeTeamMember());

      const result = await service.createBusiness(
        { name: "Priya's Boutique", email: 'priya@example.com' },
        OWNER_ID,
        'owner@example.com',
      );

      expect(result).toEqual(created);
      expect(repository.createBusiness).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Priya's Boutique",
          slug: 'priyas-boutique',
          email: 'priya@example.com',
          plan: 'free',
          country: 'IN',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        }),
      );
      expect(repository.createOwnerMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ email: 'owner@example.com', userId: OWNER_ID }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.created',
        expect.objectContaining({ businessId: BUSINESS_ID, ownerId: OWNER_ID, plan: 'free' }),
      );
    });

    it('appends a numeric suffix when the slug already exists', async () => {
      repository.findBusinessByEmail.mockResolvedValue(null);
      repository.findBusinessBySlug
        .mockResolvedValueOnce(makeBusiness({ slug: 'test-shop' })) // base taken
        .mockResolvedValueOnce(null); // -2 free
      repository.createBusiness.mockResolvedValue(makeBusiness());
      repository.createOwnerMember.mockResolvedValue(makeTeamMember());

      await service.createBusiness({ name: 'Test Shop', email: 'new@example.com' }, OWNER_ID);

      expect(repository.createBusiness).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'test-shop-2' }),
      );
    });

    it('honours an explicit plan and stores its limits', async () => {
      repository.findBusinessByEmail.mockResolvedValue(null);
      repository.findBusinessBySlug.mockResolvedValue(null);
      repository.createBusiness.mockResolvedValue(makeBusiness({ plan: 'growth' }));
      repository.createOwnerMember.mockResolvedValue(makeTeamMember());

      await service.createBusiness(
        { name: 'Growth Co', email: 'g@example.com', plan: SubscriptionTier.GROWTH },
        OWNER_ID,
      );

      expect(repository.createBusiness).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: 'growth',
          plan_limits: expect.objectContaining({ maxChannels: 5, maxTeamMembers: 10 }),
        }),
      );
    });

    it('rejects a duplicate business email', async () => {
      repository.findBusinessByEmail.mockResolvedValue(makeBusiness());

      await expect(
        service.createBusiness({ name: 'Dup', email: 'test@example.com' }, OWNER_ID),
      ).rejects.toThrow(BadRequestException);
      expect(repository.createBusiness).not.toHaveBeenCalled();
    });
  });

  describe('suspendBusiness', () => {
    it('sets is_active false, records reason, emits event', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      repository.updateBusiness.mockResolvedValue(makeBusiness({ is_active: false }));

      const result = await service.suspendBusiness(BUSINESS_ID, { reason: 'non-payment' });

      expect(result.is_active).toBe(false);
      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          is_active: false,
          profile: expect.objectContaining({ suspendedReason: 'non-payment' }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.suspended',
        expect.objectContaining({ businessId: BUSINESS_ID, reason: 'non-payment' }),
      );
    });

    it('throws NotFoundException for a missing business', async () => {
      repository.findBusinessById.mockResolvedValue(null);
      await expect(service.suspendBusiness(BUSINESS_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('activateBusiness', () => {
    it('activates a business that has at least one channel and emits event', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ is_active: false, profile: { suspendedReason: 'x' } }),
      );
      repository.countChannelAccounts.mockResolvedValue(1);
      repository.updateBusiness.mockResolvedValue(makeBusiness({ is_active: true }));

      const result = await service.activateBusiness(BUSINESS_ID);

      expect(result.is_active).toBe(true);
      // suspension fields cleared
      const updateArg = repository.updateBusiness.mock.calls[0][1];
      expect(updateArg.profile).not.toHaveProperty('suspendedReason');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.activated',
        expect.objectContaining({ businessId: BUSINESS_ID }),
      );
    });

    it('rejects activation with no connected channels', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ is_active: false }));
      repository.countChannelAccounts.mockResolvedValue(0);

      await expect(service.activateBusiness(BUSINESS_ID)).rejects.toThrow(BadRequestException);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
    });
  });

  // ─── Business Profile ────────────────────────

  describe('getBusinessById', () => {
    it('should return the business when found', async () => {
      const business = makeBusiness();
      repository.findBusinessById.mockResolvedValue(business);

      const result = await service.getBusinessById(BUSINESS_ID);

      expect(result).toEqual(business);
      expect(repository.findBusinessById).toHaveBeenCalledWith(BUSINESS_ID);
    });

    it('should throw NotFoundException when business does not exist', async () => {
      repository.findBusinessById.mockResolvedValue(null);

      await expect(service.getBusinessById(BUSINESS_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateBusiness', () => {
    it('should update business name and emit event', async () => {
      const business = makeBusiness();
      const updated = makeBusiness({ name: 'Updated Shop' });
      repository.findBusinessById.mockResolvedValue(business);
      repository.updateBusiness.mockResolvedValue(updated);

      const dto: UpdateBusinessDto = { name: 'Updated Shop' };
      const result = await service.updateBusiness(BUSINESS_ID, dto);

      expect(result).toEqual(updated);
      expect(repository.updateBusiness).toHaveBeenCalledWith(BUSINESS_ID, {
        name: 'Updated Shop',
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.settings.updated',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          changedFields: ['name'],
        }),
      );
    });

    it('should reject duplicate email across businesses', async () => {
      const business = makeBusiness();
      const otherBusiness = makeBusiness({
        id: '99999999-9999-9999-9999-999999999999',
        email: 'taken@example.com',
      });
      repository.findBusinessById.mockResolvedValue(business);
      repository.findBusinessByEmail.mockResolvedValue(otherBusiness);

      const dto: UpdateBusinessDto = { email: 'taken@example.com' };

      await expect(service.updateBusiness(BUSINESS_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow updating email to its own current value', async () => {
      const business = makeBusiness({ email: 'test@example.com' });
      repository.findBusinessById.mockResolvedValue(business);
      repository.findBusinessByEmail.mockResolvedValue(business);
      repository.updateBusiness.mockResolvedValue(business);

      const dto: UpdateBusinessDto = { email: 'test@example.com' };
      const result = await service.updateBusiness(BUSINESS_ID, dto);

      expect(result).toEqual(business);
    });

    it('should return existing business unchanged when no fields are provided', async () => {
      const business = makeBusiness();
      repository.findBusinessById.mockResolvedValue(business);

      const result = await service.updateBusiness(BUSINESS_ID, {});

      expect(result).toEqual(business);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ─── AI Configuration ────────────────────────

  describe('getAIConfig', () => {
    it('should return defaults when no ai_settings stored', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const config = await service.getAIConfig(BUSINESS_ID);

      expect(config.autoExecuteThreshold).toBe(90);
      expect(config.reviewThreshold).toBe(70);
      expect(config.personalityPrompt).toBe('');
      expect(config.responseLanguage).toBe('en');
    });

    it('should merge stored settings with defaults', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          ai_settings: { autoExecuteThreshold: 85, personalityPrompt: 'Be friendly' },
        }),
      );

      const config = await service.getAIConfig(BUSINESS_ID);

      expect(config.autoExecuteThreshold).toBe(85);
      expect(config.reviewThreshold).toBe(70); // default
      expect(config.personalityPrompt).toBe('Be friendly');
    });
  });

  describe('updateAIConfig', () => {
    it('should update thresholds and emit event', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      repository.updateBusiness.mockResolvedValue(makeBusiness());

      const dto: UpdateAIConfigDto = {
        autoExecuteThreshold: 95,
        reviewThreshold: 75,
      };
      const result = await service.updateAIConfig(BUSINESS_ID, dto);

      expect(result.autoExecuteThreshold).toBe(95);
      expect(result.reviewThreshold).toBe(75);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.settings.updated',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          changedFields: ['ai_settings'],
        }),
      );
    });

    it('should reject when autoExecuteThreshold < reviewThreshold', async () => {
      const dto: UpdateAIConfigDto = {
        autoExecuteThreshold: 60,
        reviewThreshold: 80,
      };

      await expect(service.updateAIConfig(BUSINESS_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── Channel Connections ─────────────────────

  describe('getChannelConnections', () => {
    it('should return all active channels', async () => {
      const channels = [makeChannelAccount()];
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      repository.findChannelAccounts.mockResolvedValue(channels);

      const result = await service.getChannelConnections(BUSINESS_ID);

      expect(result).toEqual(channels);
      expect(repository.findChannelAccounts).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });

  describe('connectChannel', () => {
    it('should create channel when within plan limits', async () => {
      const newChannel = makeChannelAccount();
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countChannelAccounts.mockResolvedValue(0);
      repository.createChannelAccount.mockResolvedValue(newChannel);

      const dto: ConnectChannelDto = {
        channelType: ChannelType.WHATSAPP,
        name: 'Main WhatsApp',
        externalId: '1234567890',
        credentials: { apiKey: 'test' },
      };

      const result = await service.connectChannel(BUSINESS_ID, dto);

      expect(result).toEqual(newChannel);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.channel.connected',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          channelType: ChannelType.WHATSAPP,
        }),
      );
    });

    it('should reject when plan channel limit is reached', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countChannelAccounts.mockResolvedValue(1); // starter limit = 1

      const dto: ConnectChannelDto = {
        channelType: ChannelType.INSTAGRAM,
        name: 'IG Account',
        externalId: 'ig_123',
        credentials: {},
      };

      await expect(service.connectChannel(BUSINESS_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow unlimited channels on scale plan', async () => {
      const newChannel = makeChannelAccount();
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'scale' }));
      repository.countChannelAccounts.mockResolvedValue(100);
      repository.createChannelAccount.mockResolvedValue(newChannel);

      const dto: ConnectChannelDto = {
        channelType: ChannelType.SMS,
        name: 'SMS Gateway',
        externalId: 'sms_123',
        credentials: {},
      };

      const result = await service.connectChannel(BUSINESS_ID, dto);
      expect(result).toEqual(newChannel);
    });
  });

  describe('disconnectChannel', () => {
    it('should soft-delete channel and emit event', async () => {
      const channel = makeChannelAccount();
      repository.findChannelAccountById.mockResolvedValue(channel);
      repository.softDeleteChannelAccount.mockResolvedValue({
        ...channel,
        deleted_at: new Date(),
      });

      await service.disconnectChannel(BUSINESS_ID, CHANNEL_ACCOUNT_ID);

      expect(repository.softDeleteChannelAccount).toHaveBeenCalledWith(
        BUSINESS_ID,
        CHANNEL_ACCOUNT_ID,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.channel.disconnected',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          channelAccountId: CHANNEL_ACCOUNT_ID,
        }),
      );
    });

    it('should throw NotFoundException for non-existent channel', async () => {
      repository.findChannelAccountById.mockResolvedValue(null);

      await expect(
        service.disconnectChannel(BUSINESS_ID, CHANNEL_ACCOUNT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Team Members ────────────────────────────

  describe('inviteMember', () => {
    it('should create invited member with token', async () => {
      const newMember = makeTeamMember({ status: TeamMemberStatus.INVITED });
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countTeamMembers.mockResolvedValue(1);
      repository.findTeamMemberByEmail.mockResolvedValue(null);
      repository.createTeamMember.mockResolvedValue(newMember);

      const dto: InviteMemberDto = {
        email: 'new@example.com',
        name: 'New Staff',
        role: TeamRole.STAFF,
      };

      const result = await service.inviteMember(BUSINESS_ID, dto, OWNER_ID);

      expect(result).toEqual(newMember);
      expect(repository.createTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          email: 'new@example.com',
          name: 'New Staff',
          role: TeamMemberRole.STAFF,
          invited_by: OWNER_ID,
        }),
      );
    });

    it('should reject when staff limit is reached', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countTeamMembers.mockResolvedValue(3); // starter limit = 3

      const dto: InviteMemberDto = {
        email: 'new@example.com',
        name: 'New Staff',
        role: TeamRole.STAFF,
      };

      await expect(service.inviteMember(BUSINESS_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject duplicate email within the same business', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      repository.countTeamMembers.mockResolvedValue(1);
      repository.findTeamMemberByEmail.mockResolvedValue(makeTeamMember());

      const dto: InviteMemberDto = {
        email: 'member@example.com',
        name: 'Duplicate',
        role: TeamRole.STAFF,
      };

      await expect(service.inviteMember(BUSINESS_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('removeMember', () => {
    it('should soft-delete a non-owner member', async () => {
      const member = makeTeamMember({ role: TeamMemberRole.STAFF });
      repository.findTeamMemberById.mockResolvedValue(member);
      repository.softDeleteTeamMember.mockResolvedValue({
        ...member,
        deleted_at: new Date(),
      });

      await service.removeMember(BUSINESS_ID, MEMBER_ID);

      expect(repository.softDeleteTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        MEMBER_ID,
      );
    });

    it('should throw ForbiddenException when trying to remove OWNER', async () => {
      const owner = makeTeamMember({ role: TeamMemberRole.OWNER });
      repository.findTeamMemberById.mockResolvedValue(owner);

      await expect(service.removeMember(BUSINESS_ID, MEMBER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException for non-existent member', async () => {
      repository.findTeamMemberById.mockResolvedValue(null);

      await expect(service.removeMember(BUSINESS_ID, MEMBER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── Business Policies ──────────────────────

  describe('getPolicies', () => {
    it('should return defaults when no policies stored', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const policies = await service.getPolicies(BUSINESS_ID);

      expect(policies.refundWindowDays).toBe(7);
      expect(policies.maxRefundAmountPaise).toBe(500000);
      expect(policies.slaFirstResponseMinutes).toBe(15);
    });

    it('should merge stored policies with defaults', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          profile: { policies: { refundWindowDays: 14, maxRefundAmountPaise: 100000 } },
        }),
      );

      const policies = await service.getPolicies(BUSINESS_ID);

      expect(policies.refundWindowDays).toBe(14);
      expect(policies.maxRefundAmountPaise).toBe(100000);
      expect(policies.slaFirstResponseMinutes).toBe(15); // default
    });
  });

  describe('updatePolicies', () => {
    it('should merge new policies with existing and emit event', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          profile: { policies: { refundWindowDays: 7 }, companyBio: 'Hello' },
        }),
      );
      repository.updateBusiness.mockResolvedValue(makeBusiness());

      const dto: UpdateBusinessPoliciesDto = {
        refundWindowDays: 14,
        slaFirstResponseMinutes: 30,
      };

      const result = await service.updatePolicies(BUSINESS_ID, dto);

      expect(result.refundWindowDays).toBe(14);
      expect(result.slaFirstResponseMinutes).toBe(30);

      // Verify that existing profile data (companyBio) is preserved
      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            companyBio: 'Hello',
            policies: expect.objectContaining({
              refundWindowDays: 14,
              slaFirstResponseMinutes: 30,
            }),
          }),
        }),
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.settings.updated',
        expect.objectContaining({
          businessId: BUSINESS_ID,
          changedFields: ['policies'],
        }),
      );
    });
  });
});
