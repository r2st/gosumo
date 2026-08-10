import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  businesses,
  channel_accounts,
  team_members,
  business_rules,
  ChannelType,
  TeamMemberRole,
  RuleType,
} from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { generateId } from '@gosumo/shared';
import { TenantRepository } from './tenant.repository';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateAIConfigDto, AIConfigResponse } from './dto/ai-config.dto';
import { ConnectChannelDto } from './dto/connect-channel.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { SuspendBusinessDto } from './dto/suspend-business.dto';
import { UpdateBusinessPoliciesDto, BusinessPoliciesResponse } from './dto/business-policies.dto';
import {
  AI_CONFIG_DEFAULTS,
  POLICIES_DEFAULTS,
  SubscriptionTier,
  resolvePlan,
  isUnlimited,
  slugify,
} from './tenant.constants';

// ─────────────────────────────────────────────
// Plan limit shape (resource quotas surfaced to callers)
// ─────────────────────────────────────────────

interface PlanResourceLimits {
  maxChannels: number;
  maxStaff: number;
}

const MAX_SLUG_ATTEMPTS = 50;

/**
 * TenantService — core business logic for tenant/business management.
 *
 * Handles business lifecycle (create / suspend / activate), profiles, AI
 * configuration, channel connections, team membership, and business policies.
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(
    private readonly repository: TenantRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // Business Lifecycle
  // ─────────────────────────────────────────────

  /**
   * Create a new business (tenant) and its founding OWNER member.
   *
   * Generates a unique URL-safe slug from the business name (appending a numeric
   * suffix on collision), seeds default AI settings, plan limits, and a fresh
   * onboarding checklist, then emits `business.created`.
   *
   * @param dto      Business profile data
   * @param ownerId  The team member / user UUID that owns this business
   * @param ownerEmail Optional owner email (defaults to the business email)
   */
  async createBusiness(
    dto: CreateBusinessDto,
    ownerId: string,
    ownerEmail?: string,
  ): Promise<businesses> {
    // Reject duplicate business email up front for a clean 400.
    const existingEmail = await this.repository.findBusinessByEmail(dto.email);
    if (existingEmail) {
      throw new BadRequestException(
        `Email "${dto.email}" is already in use by another business`,
      );
    }

    const slug = await this.generateUniqueSlug(dto.name);
    const planId = (dto.plan ?? SubscriptionTier.FREE).toLowerCase();
    const plan = resolvePlan(planId);

    const profile: Record<string, unknown> = {
      onboarding: { completedSteps: [] as string[] },
    };
    if (dto.gstNumber) {
      profile['gstNumber'] = dto.gstNumber;
    }

    const business = await this.repository.createBusiness({
      name: dto.name,
      slug,
      email: dto.email,
      phone: dto.phone,
      country: dto.country ?? 'IN',
      timezone: dto.timezone ?? 'Asia/Kolkata',
      currency: dto.currency ?? 'INR',
      plan: plan.id,
      plan_limits: { ...plan.limits },
      ai_settings: { ...AI_CONFIG_DEFAULTS },
      profile,
    });

    // Founding owner member.
    await this.repository.createOwnerMember(business.id, {
      email: ownerEmail ?? dto.email,
      name: dto.name,
      userId: ownerId,
    });

    this.eventEmitter.emit('business.created', {
      businessId: business.id,
      ownerId,
      businessName: business.name,
      plan: plan.id,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Business created: ${business.id} ("${business.name}", slug=${slug}, plan=${plan.id})`,
    );

    return business;
  }

  /**
   * Suspend a business — sets `is_active = false` and records the reason on the
   * profile. A suspended business stops processing new messages. Idempotent.
   * Emits `business.suspended`.
   */
  async suspendBusiness(
    businessId: string,
    dto: SuspendBusinessDto = {},
  ): Promise<businesses> {
    const business = await this.getBusinessById(businessId);

    const profile = this.toRecord(business.profile);
    profile['suspendedAt'] = new Date().toISOString();
    if (dto.reason) {
      profile['suspendedReason'] = dto.reason;
    }

    const updated = await this.repository.updateBusiness(businessId, {
      is_active: false,
      profile: profile as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.suspended', {
      businessId,
      reason: dto.reason,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Business ${businessId} suspended${dto.reason ? `: ${dto.reason}` : ''}`,
    );

    return updated;
  }

  /**
   * Activate (or re-activate) a business — sets `is_active = true`.
   *
   * A business must have at least one connected channel before it can go
   * active, per the onboarding requirement. Clears any prior suspension reason.
   * Emits `business.activated`.
   */
  async activateBusiness(businessId: string): Promise<businesses> {
    const business = await this.getBusinessById(businessId);

    const channelCount = await this.repository.countChannelAccounts(businessId);
    if (channelCount === 0) {
      throw new BadRequestException(
        'A business must have at least one connected channel before it can be activated',
      );
    }

    const profile = this.toRecord(business.profile);
    delete profile['suspendedAt'];
    delete profile['suspendedReason'];

    const updated = await this.repository.updateBusiness(businessId, {
      is_active: true,
      profile: profile as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.activated', {
      businessId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Business ${businessId} activated`);

    return updated;
  }

  // ─────────────────────────────────────────────
  // Business Profile
  // ─────────────────────────────────────────────

  /**
   * Get a business by ID. Throws NotFoundException if not found.
   */
  async getBusinessById(businessId: string): Promise<businesses> {
    const business = await this.repository.findBusinessById(businessId);

    if (!business) {
      throw new NotFoundException(`Business not found: ${businessId}`);
    }

    return business;
  }

  /**
   * Update business profile fields. Validates that email is not duplicated
   * across businesses if it is being changed.
   */
  async updateBusiness(
    businessId: string,
    dto: UpdateBusinessDto,
  ): Promise<businesses> {
    // Ensure business exists
    const existing = await this.getBusinessById(businessId);

    // If email is being changed, check for duplicates
    if (dto.email && dto.email !== existing.email) {
      const duplicate = await this.repository.findBusinessByEmail(dto.email);
      if (duplicate && duplicate.id !== businessId) {
        throw new BadRequestException(
          `Email "${dto.email}" is already in use by another business`,
        );
      }
    }

    // Build the update payload from only the supplied fields
    const updateData: Record<string, unknown> = {};
    const changedFields: string[] = [];

    if (dto.name !== undefined) {
      updateData['name'] = dto.name;
      changedFields.push('name');
    }
    if (dto.phone !== undefined) {
      updateData['phone'] = dto.phone;
      changedFields.push('phone');
    }
    if (dto.email !== undefined) {
      updateData['email'] = dto.email;
      changedFields.push('email');
    }
    if (dto.timezone !== undefined) {
      updateData['timezone'] = dto.timezone;
      changedFields.push('timezone');
    }
    if (dto.currency !== undefined) {
      updateData['currency'] = dto.currency;
      changedFields.push('currency');
    }

    if (changedFields.length === 0) {
      return existing;
    }

    const updated = await this.repository.updateBusiness(businessId, updateData);

    this.eventEmitter.emit('business.settings.updated', {
      businessId,
      changedFields,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Business ${businessId} updated: ${changedFields.join(', ')}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // AI Configuration
  // ─────────────────────────────────────────────

  /**
   * Get the AI configuration for a business, merging stored settings
   * with defaults.
   */
  async getAIConfig(businessId: string): Promise<AIConfigResponse> {
    const business = await this.getBusinessById(businessId);
    const stored = (business.ai_settings ?? {}) as Record<string, unknown>;

    return {
      ...AI_CONFIG_DEFAULTS,
      ...stored,
    } as AIConfigResponse;
  }

  /**
   * Update AI configuration thresholds. Validates that
   * autoExecuteThreshold >= reviewThreshold.
   */
  async updateAIConfig(
    businessId: string,
    dto: UpdateAIConfigDto,
  ): Promise<AIConfigResponse> {
    if (dto.autoExecuteThreshold < dto.reviewThreshold) {
      throw new BadRequestException(
        'autoExecuteThreshold must be greater than or equal to reviewThreshold',
      );
    }

    const business = await this.getBusinessById(businessId);
    const existingSettings = (business.ai_settings ?? {}) as Record<string, unknown>;

    const merged: Record<string, unknown> = {
      ...existingSettings,
      autoExecuteThreshold: dto.autoExecuteThreshold,
      reviewThreshold: dto.reviewThreshold,
    };

    if (dto.personalityPrompt !== undefined) {
      merged['personalityPrompt'] = dto.personalityPrompt;
    }
    if (dto.responseLanguage !== undefined) {
      merged['responseLanguage'] = dto.responseLanguage;
    }

    await this.repository.updateBusiness(businessId, {
      ai_settings: merged as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.settings.updated', {
      businessId,
      changedFields: ['ai_settings'],
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `AI config updated for business ${businessId}: ` +
        `autoExecute=${dto.autoExecuteThreshold}, review=${dto.reviewThreshold}`,
    );

    return {
      ...AI_CONFIG_DEFAULTS,
      ...merged,
    } as AIConfigResponse;
  }

  // ─────────────────────────────────────────────
  // Channel Connections
  // ─────────────────────────────────────────────

  /**
   * List all active channel connections for a business.
   */
  async getChannelConnections(businessId: string): Promise<channel_accounts[]> {
    // Verify business exists
    await this.getBusinessById(businessId);
    return this.repository.findChannelAccounts(businessId);
  }

  /**
   * Connect a new messaging channel to a business.
   * Checks plan limits before creating.
   */
  async connectChannel(
    businessId: string,
    dto: ConnectChannelDto,
  ): Promise<channel_accounts> {
    const business = await this.getBusinessById(businessId);

    // Check plan limits
    const limits = this.getPlanLimits(business.plan);
    const currentCount = await this.repository.countChannelAccounts(businessId);

    if (currentCount >= limits.maxChannels) {
      throw new BadRequestException(
        `Plan "${business.plan}" allows a maximum of ${limits.maxChannels} channel(s). ` +
          `Currently connected: ${currentCount}. Upgrade your plan to add more channels.`,
      );
    }

    // ChannelType from @gosumo/shared and @gosumo/database share the same
    // string values. The repository expects the Prisma-generated enum.
    const dbChannelType = dto.channelType as string as ChannelType;

    const channelAccount = await this.repository.createChannelAccount(businessId, {
      channel: dbChannelType,
      name: dto.name,
      external_id: dto.externalId,
      external_account: dto.externalAccount,
      credentials: dto.credentials,
    });

    this.eventEmitter.emit('business.channel.connected', {
      businessId,
      channelType: dto.channelType,
      channelAccountId: channelAccount.id,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Channel ${dto.channelType} connected for business ${businessId}: ${channelAccount.id}`,
    );

    return channelAccount;
  }

  /**
   * Disconnect (soft-delete) a channel account.
   */
  async disconnectChannel(
    businessId: string,
    channelAccountId: string,
  ): Promise<void> {
    const channelAccount = await this.repository.findChannelAccountById(
      businessId,
      channelAccountId,
    );

    if (!channelAccount) {
      throw new NotFoundException(
        `Channel account not found: ${channelAccountId}`,
      );
    }

    await this.repository.softDeleteChannelAccount(businessId, channelAccountId);

    this.eventEmitter.emit('business.channel.disconnected', {
      businessId,
      channelType: channelAccount.channel,
      channelAccountId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Channel ${channelAccount.channel} disconnected for business ${businessId}: ${channelAccountId}`,
    );
  }

  /**
   * Update a channel account's status (active/paused) without disconnecting it.
   * Emits `business.settings.updated` so downstream caches can react.
   */
  async setChannelStatus(
    businessId: string,
    channelAccountId: string,
    isActive: boolean,
  ): Promise<channel_accounts> {
    const channelAccount = await this.repository.findChannelAccountById(
      businessId,
      channelAccountId,
    );

    if (!channelAccount) {
      throw new NotFoundException(
        `Channel account not found: ${channelAccountId}`,
      );
    }

    const updated = await this.repository.setChannelAccountActive(
      businessId,
      channelAccountId,
      isActive,
    );

    this.eventEmitter.emit('business.settings.updated', {
      businessId,
      changedFields: ['channelStatus'],
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Channel ${channelAccount.channel} ${isActive ? 'activated' : 'paused'} ` +
        `for business ${businessId}: ${channelAccountId}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────
  // Team Members
  // ─────────────────────────────────────────────

  /**
   * List all active and invited team members for a business.
   */
  async getMembers(businessId: string): Promise<team_members[]> {
    await this.getBusinessById(businessId);
    return this.repository.findTeamMembers(businessId);
  }

  /**
   * Assert that `memberId` names a live team member of `businessId`.
   *
   * The tenant guard for *assignee* fields. `@TenantId()` scopes the row being
   * written, but a caller-supplied member id inside the body is a second,
   * unscoped reference: without this check a business can write another
   * business's `team_members.id` into its own `tasks.assigned_to` or
   * `realty_leads.assigned_agent_id`. The `tasks.assigned_to` foreign key is
   * satisfied by *any* real member row, so the database does not catch it.
   *
   * Nothing is returned — callers only need the assertion, and returning the
   * row would invite it being used as a tenant-scoped member read, which
   * `getMembers` already provides.
   *
   * @throws BadRequestException when the member does not exist in this tenant.
   */
  async assertTeamMember(businessId: string, memberId: string): Promise<void> {
    const member = await this.repository.findTeamMemberById(businessId, memberId);
    if (!member) {
      // Deliberately does not distinguish "no such member" from "member of
      // another business" — the difference would confirm the existence of an
      // id outside the caller's tenant.
      throw new BadRequestException(
        `Team member ${memberId} does not belong to this business`,
      );
    }
  }

  /**
   * Invite a new team member. Creates with INVITED status and generates
   * a unique invite token (UUID).
   *
   * Checks plan limits and duplicate email within the business.
   */
  async inviteMember(
    businessId: string,
    dto: InviteMemberDto,
    invitedBy?: string,
  ): Promise<team_members> {
    const business = await this.getBusinessById(businessId);

    // Check plan limits for staff count
    const limits = this.getPlanLimits(business.plan);
    const currentCount = await this.repository.countTeamMembers(businessId);

    if (currentCount >= limits.maxStaff) {
      throw new BadRequestException(
        `Plan "${business.plan}" allows a maximum of ${limits.maxStaff} team member(s). ` +
          `Current count: ${currentCount}. Upgrade your plan to add more members.`,
      );
    }

    // Check for existing member with same email in this business
    const existingMember = await this.repository.findTeamMemberByEmail(
      businessId,
      dto.email,
    );
    if (existingMember) {
      throw new BadRequestException(
        `A team member with email "${dto.email}" already exists in this business`,
      );
    }

    // Map shared TeamRole to Prisma TeamMemberRole
    const roleMap: Record<string, TeamMemberRole> = {
      OWNER: TeamMemberRole.OWNER,
      MANAGER: TeamMemberRole.MANAGER,
      STAFF: TeamMemberRole.STAFF,
    };
    const prismaRole = roleMap[dto.role] ?? TeamMemberRole.STAFF;

    const inviteToken = generateId();

    const member = await this.repository.createTeamMember(businessId, {
      email: dto.email,
      name: dto.name,
      role: prismaRole,
      invite_token: inviteToken,
      invited_by: invitedBy,
    });

    this.logger.log(
      `Team member invited for business ${businessId}: ${dto.email} as ${dto.role}`,
    );

    return member;
  }

  /**
   * Remove a team member (soft-delete). Cannot remove the OWNER.
   */
  async removeMember(
    businessId: string,
    memberId: string,
  ): Promise<void> {
    const member = await this.repository.findTeamMemberById(businessId, memberId);

    if (!member) {
      throw new NotFoundException(`Team member not found: ${memberId}`);
    }

    if (member.role === TeamMemberRole.OWNER) {
      throw new ForbiddenException(
        'Cannot remove the business owner. Transfer ownership first.',
      );
    }

    await this.repository.softDeleteTeamMember(businessId, memberId);

    this.logger.log(
      `Team member ${memberId} removed from business ${businessId}`,
    );
  }

  // ─────────────────────────────────────────────
  // Business Policies
  // ─────────────────────────────────────────────

  /**
   * Get business policies from the profile JSON, merged with defaults.
   */
  async getPolicies(businessId: string): Promise<BusinessPoliciesResponse> {
    const business = await this.getBusinessById(businessId);
    const profile = (business.profile ?? {}) as Record<string, unknown>;
    const policies = (profile['policies'] ?? {}) as Record<string, unknown>;

    return {
      ...POLICIES_DEFAULTS,
      ...policies,
    } as BusinessPoliciesResponse;
  }

  /**
   * Update business policies by merging into the profile JSON.
   */
  async updatePolicies(
    businessId: string,
    dto: UpdateBusinessPoliciesDto,
  ): Promise<BusinessPoliciesResponse> {
    const business = await this.getBusinessById(businessId);
    const existingProfile = (business.profile ?? {}) as Record<string, unknown>;
    const existingPolicies = (existingProfile['policies'] ?? {}) as Record<string, unknown>;

    // Merge only the supplied fields
    const updatedPolicies: Record<string, unknown> = { ...existingPolicies };

    if (dto.refundWindowDays !== undefined) {
      updatedPolicies['refundWindowDays'] = dto.refundWindowDays;
    }
    if (dto.maxRefundAmountPaise !== undefined) {
      updatedPolicies['maxRefundAmountPaise'] = dto.maxRefundAmountPaise;
    }
    if (dto.slaFirstResponseMinutes !== undefined) {
      updatedPolicies['slaFirstResponseMinutes'] = dto.slaFirstResponseMinutes;
    }
    if (dto.slaResolutionMinutes !== undefined) {
      updatedPolicies['slaResolutionMinutes'] = dto.slaResolutionMinutes;
    }
    if (dto.maxAutoDiscountPercent !== undefined) {
      updatedPolicies['maxAutoDiscountPercent'] = dto.maxAutoDiscountPercent;
    }

    const updatedProfile = {
      ...existingProfile,
      policies: updatedPolicies,
    };

    await this.repository.updateBusiness(businessId, {
      profile: updatedProfile as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.settings.updated', {
      businessId,
      changedFields: ['policies'],
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Business policies updated for ${businessId}`);

    return {
      ...POLICIES_DEFAULTS,
      ...updatedPolicies,
    } as BusinessPoliciesResponse;
  }

  // ─────────────────────────────────────────────
  // Business Rules
  // ─────────────────────────────────────────────

  /**
   * Get active business rules, optionally filtered by type.
   */
  async getBusinessRules(
    businessId: string,
    type?: RuleType,
  ): Promise<business_rules[]> {
    await this.getBusinessById(businessId);
    return this.repository.findBusinessRules(businessId, type);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /**
   * Resolve resource limits (channels, staff) for the given plan name,
   * converting the unlimited sentinel to Infinity for comparison.
   * Falls back to STARTER for unknown plans.
   */
  private getPlanLimits(plan: string): PlanResourceLimits {
    const def = resolvePlan(plan);
    return {
      maxChannels: isUnlimited(def.limits.maxChannels) ? Infinity : def.limits.maxChannels,
      maxStaff: isUnlimited(def.limits.maxTeamMembers) ? Infinity : def.limits.maxTeamMembers,
    };
  }

  /**
   * Generate a unique, URL-safe slug from a business name. Appends `-2`, `-3`,
   * … on collision (slugs are never reused, even for soft-deleted businesses).
   */
  private async generateUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const existing = await this.repository.findBusinessBySlug(candidate);
      if (!existing) {
        return candidate;
      }
      candidate = `${base}-${attempt}`.slice(0, 100);
    }
    // Extremely unlikely — fall back to a slug with a random suffix.
    return `${base}-${generateId()}`.slice(0, 100);
  }

  /** Coerce a JSON value into a shallow-cloned plain object. */
  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }

  /**
   * Health check / status.
   */
  getStatus(): Record<string, string> {
    return { module: 'Tenant', status: 'ready' };
  }
}
