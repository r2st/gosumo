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
    countOwners: jest.fn(),
    findTeamMemberById: jest.fn(),
    findAssignableTeamMembers: jest.fn(),
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
    /** Rank the acting user, as `assertActorOutranks` will read them. */
    function actingAs(role: TeamMemberRole) {
      repository.findTeamMemberById.mockResolvedValue(makeTeamMember({ id: OWNER_ID, role }));
    }

    it('should create invited member with token', async () => {
      const newMember = makeTeamMember({ status: TeamMemberStatus.INVITED });
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'starter' }));
      repository.countTeamMembers.mockResolvedValue(1);
      repository.findTeamMemberByEmail.mockResolvedValue(null);
      repository.createTeamMember.mockResolvedValue(newMember);
      actingAs(TeamMemberRole.OWNER);

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

    // ─── Invited role vs. caller's own role ─────
    //
    // The role to grant arrives in the request body. `@Roles(MANAGER)` decides
    // whether the caller may touch the team at all; it cannot decide *which*
    // role they may hand out. Without the cap below, a manager invites a
    // second account of their own as OWNER and escalates through it.

    function invite(role: TeamRole): InviteMemberDto {
      return { email: 'new@example.com', name: 'New', role };
    }

    function allowInvite() {
      repository.findBusinessById.mockResolvedValue(makeBusiness({ plan: 'scale' }));
      repository.countTeamMembers.mockResolvedValue(1);
      repository.findTeamMemberByEmail.mockResolvedValue(null);
      repository.createTeamMember.mockResolvedValue(makeTeamMember());
    }

    it('refuses a manager inviting an owner', async () => {
      allowInvite();
      actingAs(TeamMemberRole.MANAGER);

      await expect(
        service.inviteMember(BUSINESS_ID, invite(TeamRole.OWNER), OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.createTeamMember).not.toHaveBeenCalled();
    });

    it('refuses a staff member inviting a manager', async () => {
      allowInvite();
      actingAs(TeamMemberRole.STAFF);

      await expect(
        service.inviteMember(BUSINESS_ID, invite(TeamRole.MANAGER), OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.createTeamMember).not.toHaveBeenCalled();
    });

    it('refuses a viewer inviting anyone at all', async () => {
      // The originally reported escalation: a VIEWER posting {role: 'OWNER'}.
      // VIEWER outranks nothing, so even a STAFF invite is refused.
      allowInvite();
      actingAs(TeamMemberRole.VIEWER);

      await expect(
        service.inviteMember(BUSINESS_ID, invite(TeamRole.OWNER), OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.inviteMember(BUSINESS_ID, invite(TeamRole.STAFF), OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.createTeamMember).not.toHaveBeenCalled();
    });

    it('allows a manager inviting a manager — equal rank is not escalation', async () => {
      allowInvite();
      actingAs(TeamMemberRole.MANAGER);

      await service.inviteMember(BUSINESS_ID, invite(TeamRole.MANAGER), OWNER_ID);

      expect(repository.createTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ role: TeamMemberRole.MANAGER }),
      );
    });

    it('allows an owner inviting an owner', async () => {
      allowInvite();
      actingAs(TeamMemberRole.OWNER);

      await service.inviteMember(BUSINESS_ID, invite(TeamRole.OWNER), OWNER_ID);

      expect(repository.createTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ role: TeamMemberRole.OWNER }),
      );
    });

    it('refuses when the acting user is no longer a member of the business', async () => {
      allowInvite();
      repository.findTeamMemberById.mockResolvedValue(null);

      await expect(
        service.inviteMember(BUSINESS_ID, invite(TeamRole.STAFF), OWNER_ID),
      ).rejects.toThrow(/not a member of this business/i);
      expect(repository.createTeamMember).not.toHaveBeenCalled();
    });

    it('scopes the actor lookup to the calling business', async () => {
      // An owner of business A must not be ranked as an owner of business B.
      allowInvite();
      actingAs(TeamMemberRole.OWNER);

      await service.inviteMember(BUSINESS_ID, invite(TeamRole.STAFF), OWNER_ID);

      expect(repository.findTeamMemberById).toHaveBeenCalledWith(BUSINESS_ID, OWNER_ID);
    });

    it('skips the rank check for system-initiated invites with no actor', async () => {
      // Business creation seeds its founding OWNER with no acting member; that
      // path is not reachable from an HTTP request.
      allowInvite();

      await service.inviteMember(BUSINESS_ID, invite(TeamRole.STAFF));

      expect(repository.findTeamMemberById).not.toHaveBeenCalled();
      expect(repository.createTeamMember).toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    /**
     * `removeMember` reads the target first, then (when an actor is given) the
     * actor. Queue both in that order.
     */
    function withLookups(targetRole: TeamMemberRole, actorRole?: TeamMemberRole) {
      repository.findTeamMemberById
        .mockResolvedValueOnce(makeTeamMember({ role: targetRole }))
        .mockResolvedValueOnce(
          actorRole === undefined ? null : makeTeamMember({ id: OWNER_ID, role: actorRole }),
        );
    }

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
      repository.countOwners.mockResolvedValue(3);

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

    // ─── Last-owner guard ───────────────────────

    it('names the last-owner case specifically when one owner is left', async () => {
      // A business with zero owners has nobody who can grant roles, invite
      // members, or manage billing, and no in-product way back.
      repository.findTeamMemberById.mockResolvedValue(
        makeTeamMember({ role: TeamMemberRole.OWNER }),
      );
      repository.countOwners.mockResolvedValue(1);

      await expect(service.removeMember(BUSINESS_ID, MEMBER_ID)).rejects.toThrow(
        /last owner/i,
      );
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
    });

    it('refuses even the sole owner removing themselves', async () => {
      // Self-service account closure is the most likely way a real business
      // strands itself.
      repository.findTeamMemberById
        .mockResolvedValueOnce(makeTeamMember({ id: OWNER_ID, role: TeamMemberRole.OWNER }))
        .mockResolvedValueOnce(makeTeamMember({ id: OWNER_ID, role: TeamMemberRole.OWNER }));
      repository.countOwners.mockResolvedValue(1);

      await expect(
        service.removeMember(BUSINESS_ID, OWNER_ID, OWNER_ID),
      ).rejects.toThrow(/last owner/i);
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
    });

    it('still refuses an owner removal when other owners remain', async () => {
      // Ownership changes hands through the role endpoint, not by deletion —
      // so this stays a 403, just with a different reason than the last-owner
      // case above.
      repository.findTeamMemberById.mockResolvedValue(
        makeTeamMember({ role: TeamMemberRole.OWNER }),
      );
      repository.countOwners.mockResolvedValue(2);

      await expect(service.removeMember(BUSINESS_ID, MEMBER_ID)).rejects.toThrow(
        /transfer ownership/i,
      );
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
    });

    it('does not count owners when the target is not an owner', async () => {
      repository.findTeamMemberById.mockResolvedValue(
        makeTeamMember({ role: TeamMemberRole.STAFF }),
      );
      repository.softDeleteTeamMember.mockResolvedValue(makeTeamMember());

      await service.removeMember(BUSINESS_ID, MEMBER_ID);

      expect(repository.countOwners).not.toHaveBeenCalled();
    });

    // ─── Caller rank ────────────────────────────

    it('refuses a manager removing an owner', async () => {
      withLookups(TeamMemberRole.OWNER, TeamMemberRole.MANAGER);

      await expect(
        service.removeMember(BUSINESS_ID, MEMBER_ID, OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
      // Rejected on rank before the owner-count query is worth spending.
      expect(repository.countOwners).not.toHaveBeenCalled();
    });

    it('refuses a staff member removing a manager', async () => {
      withLookups(TeamMemberRole.MANAGER, TeamMemberRole.STAFF);

      await expect(
        service.removeMember(BUSINESS_ID, MEMBER_ID, OWNER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
    });

    it('allows a manager removing another manager', async () => {
      withLookups(TeamMemberRole.MANAGER, TeamMemberRole.MANAGER);
      repository.softDeleteTeamMember.mockResolvedValue(makeTeamMember());

      await service.removeMember(BUSINESS_ID, MEMBER_ID, OWNER_ID);

      expect(repository.softDeleteTeamMember).toHaveBeenCalledWith(BUSINESS_ID, MEMBER_ID);
    });

    it('refuses when the acting user is no longer a member of the business', async () => {
      // Their access token outlives their membership by up to 15 minutes.
      withLookups(TeamMemberRole.STAFF, undefined);

      await expect(
        service.removeMember(BUSINESS_ID, MEMBER_ID, OWNER_ID),
      ).rejects.toThrow(/not a member of this business/i);
      expect(repository.softDeleteTeamMember).not.toHaveBeenCalled();
    });

    it('scopes the actor lookup to the calling business', async () => {
      // An owner of business A must not be ranked as an owner of business B.
      withLookups(TeamMemberRole.STAFF, TeamMemberRole.MANAGER);
      repository.softDeleteTeamMember.mockResolvedValue(makeTeamMember());

      await service.removeMember(BUSINESS_ID, MEMBER_ID, OWNER_ID);

      expect(repository.findTeamMemberById).toHaveBeenCalledWith(BUSINESS_ID, OWNER_ID);
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

// ─────────────────────────────────────────────
// Assignability
//
// `assertTeamMember` answers "is this one of ours?" — the tenant question.
// Routing work asks a second one, and conflating them is how a conversation
// gets parked with somebody who will never open it: assigned, so it leaves the
// unassigned queue; unresolved, so it never closes; and nobody is looking.
// ─────────────────────────────────────────────

describe('TenantService assignability', () => {
  let service: TenantService;
  let repository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    repository = createMockRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: TenantRepository, useValue: repository },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get<TenantService>(TenantService);
  });

  describe('assertAssignableTeamMember', () => {
    it('accepts an active member', async () => {
      repository.findTeamMemberById.mockResolvedValue(
        makeTeamMember({ status: TeamMemberStatus.ACTIVE }),
      );

      await expect(
        service.assertAssignableTeamMember(BUSINESS_ID, MEMBER_ID),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['a member who has never accepted the invite', TeamMemberStatus.INVITED],
      ['a suspended member', TeamMemberStatus.SUSPENDED],
    ])('refuses %s', async (_label, status) => {
      repository.findTeamMemberById.mockResolvedValue(makeTeamMember({ status }));

      await expect(
        service.assertAssignableTeamMember(BUSINESS_ID, MEMBER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a member of another business without saying so', async () => {
      // The lookup is tenant-scoped, so a foreign id simply does not resolve.
      repository.findTeamMemberById.mockResolvedValue(null);

      await expect(
        service.assertAssignableTeamMember(BUSINESS_ID, MEMBER_ID),
      ).rejects.toThrow(/does not belong to this business/i);
      expect(repository.findTeamMemberById).toHaveBeenCalledWith(BUSINESS_ID, MEMBER_ID);
    });

    it('does not leak the reason a suspended member is unavailable as a tenant hint', async () => {
      // "not yours" and "not real" must stay indistinguishable; "suspended"
      // is only ever said about a member the caller already owns.
      repository.findTeamMemberById.mockResolvedValue(null);

      const err = await service
        .assertAssignableTeamMember(BUSINESS_ID, MEMBER_ID)
        .then(() => null)
        .catch((e: unknown) => e as Error);

      expect(err?.message).not.toMatch(/suspended|invited/i);
    });
  });

  describe('filterAssignableTeamMembers', () => {
    it('keeps only the ids the repository confirms, in the caller order', async () => {
      const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      // Returned out of order on purpose: round-robin's tie-break reads the
      // candidate order, so the filter must not reorder it.
      repository.findAssignableTeamMembers.mockResolvedValue([{ id: C }, { id: A }]);

      await expect(
        service.filterAssignableTeamMembers(BUSINESS_ID, [A, B, C]),
      ).resolves.toEqual([A, C]);
    });

    it('resolves the whole list in one query rather than one per id', async () => {
      const ids = Array.from(
        { length: 50 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      repository.findAssignableTeamMembers.mockResolvedValue([]);

      await service.filterAssignableTeamMembers(BUSINESS_ID, ids);

      expect(repository.findAssignableTeamMembers).toHaveBeenCalledTimes(1);
      expect(repository.findTeamMemberById).not.toHaveBeenCalled();
    });

    it('short-circuits an empty candidate list', async () => {
      await expect(service.filterAssignableTeamMembers(BUSINESS_ID, [])).resolves.toEqual([]);
      expect(repository.findAssignableTeamMembers).not.toHaveBeenCalled();
    });
  });
});
