import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import {
  businesses,
  channel_accounts,
  team_members,
  business_rules,
  ChannelType,
  TeamMemberRole,
  TeamMemberStatus,
  RuleType,
} from '@gosumo/database';
import { Prisma } from '@prisma/client';

/**
 * TenantRepository — all Prisma queries for the Tenant module.
 *
 * Every query includes businessId scoping. Soft-deleted records
 * are excluded by default (deleted_at: null).
 */
@Injectable()
export class TenantRepository {
  private readonly logger = new Logger(TenantRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────
  // Businesses
  // ─────────────────────────────────────────────

  /**
   * Find a business by its ID. Returns null if not found or soft-deleted.
   */
  async findBusinessById(businessId: string): Promise<businesses | null> {
    return this.prisma.businesses.findFirst({
      where: {
        id: businessId,
        deleted_at: null,
      },
    });
  }

  /**
   * Find a business by email. Used to check for duplicate email on update.
   */
  async findBusinessByEmail(email: string): Promise<businesses | null> {
    return this.prisma.businesses.findFirst({
      where: {
        email,
        deleted_at: null,
      },
    });
  }

  /**
   * Find a business by slug (including soft-deleted, so slugs are never
   * silently reused). Used for slug collision detection on create.
   */
  async findBusinessBySlug(slug: string): Promise<businesses | null> {
    return this.prisma.businesses.findFirst({
      where: { slug },
    });
  }

  /**
   * Create a new business (tenant) record.
   */
  async createBusiness(data: {
    name: string;
    slug: string;
    email: string;
    phone?: string;
    country?: string;
    timezone?: string;
    currency?: string;
    plan: string;
    plan_limits: Record<string, unknown>;
    ai_settings: Record<string, unknown>;
    profile: Record<string, unknown>;
  }): Promise<businesses> {
    return this.prisma.businesses.create({
      data: {
        name: data.name,
        slug: data.slug,
        email: data.email,
        phone: data.phone,
        country: data.country,
        timezone: data.timezone,
        currency: data.currency,
        plan: data.plan,
        plan_limits: data.plan_limits as Prisma.InputJsonValue,
        ai_settings: data.ai_settings as Prisma.InputJsonValue,
        profile: data.profile as Prisma.InputJsonValue,
        is_active: true,
      },
    });
  }

  /**
   * Partial update a business record.
   */
  async updateBusiness(
    businessId: string,
    data: Prisma.businessesUpdateInput,
  ): Promise<businesses> {
    return this.prisma.businesses.update({
      where: { id: businessId },
      data,
    });
  }

  // ─────────────────────────────────────────────
  // Channel Accounts
  // ─────────────────────────────────────────────

  /**
   * List all active (non-deleted) channel accounts for a business.
   */
  async findChannelAccounts(businessId: string): Promise<channel_accounts[]> {
    return this.prisma.channel_accounts.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Find a specific channel account by ID within a business scope.
   */
  async findChannelAccountById(
    businessId: string,
    channelAccountId: string,
  ): Promise<channel_accounts | null> {
    return this.prisma.channel_accounts.findFirst({
      where: {
        id: channelAccountId,
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  /**
   * Count active channel accounts for a business (for plan limit checks).
   */
  async countChannelAccounts(businessId: string): Promise<number> {
    return this.prisma.channel_accounts.count({
      where: {
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  /**
   * Create a new channel account for a business.
   */
  async createChannelAccount(
    businessId: string,
    data: {
      channel: ChannelType;
      name: string;
      external_id: string;
      external_account?: string;
      credentials: Record<string, unknown>;
    },
  ): Promise<channel_accounts> {
    return this.prisma.channel_accounts.create({
      data: {
        business_id: businessId,
        channel: data.channel,
        name: data.name,
        external_id: data.external_id,
        external_account: data.external_account,
        credentials: data.credentials as Prisma.InputJsonValue,
        is_active: true,
      },
    });
  }

  /**
   * Soft-delete a channel account by setting deleted_at and is_active = false.
   */
  async softDeleteChannelAccount(
    businessId: string,
    channelAccountId: string,
  ): Promise<channel_accounts> {
    return this.prisma.channel_accounts.update({
      where: { id: channelAccountId, business_id: businessId },
      data: {
        deleted_at: new Date(),
        is_active: false,
      },
    });
  }

  /**
   * Toggle a channel account's active flag without disconnecting it.
   */
  async setChannelAccountActive(
    businessId: string,
    channelAccountId: string,
    isActive: boolean,
  ): Promise<channel_accounts> {
    return this.prisma.channel_accounts.update({
      where: { id: channelAccountId, business_id: businessId },
      data: { is_active: isActive },
    });
  }

  // ─────────────────────────────────────────────
  // Team Members
  // ─────────────────────────────────────────────

  /**
   * List all active and invited team members for a business.
   */
  async findTeamMembers(businessId: string): Promise<team_members[]> {
    return this.prisma.team_members.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        status: { in: [TeamMemberStatus.ACTIVE, TeamMemberStatus.INVITED] },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Count active/invited team members for a business (for plan limit checks).
   */
  async countTeamMembers(businessId: string): Promise<number> {
    return this.prisma.team_members.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        status: { in: [TeamMemberStatus.ACTIVE, TeamMemberStatus.INVITED] },
      },
    });
  }

  /**
   * Find a team member by their user ID within a business scope.
   */
  async findTeamMemberById(
    businessId: string,
    memberId: string,
  ): Promise<team_members | null> {
    return this.prisma.team_members.findFirst({
      where: {
        id: memberId,
        business_id: businessId,
        deleted_at: null,
      },
    });
  }

  /**
   * Find a team member by email within a business scope.
   */
  async findTeamMemberByEmail(
    businessId: string,
    email: string,
  ): Promise<team_members | null> {
    return this.prisma.team_members.findFirst({
      where: {
        business_id: businessId,
        email,
        deleted_at: null,
      },
    });
  }

  /**
   * Create a new team member with INVITED status.
   */
  async createTeamMember(
    businessId: string,
    data: {
      email: string;
      name: string;
      role: TeamMemberRole;
      invite_token: string;
      invited_by?: string;
    },
  ): Promise<team_members> {
    return this.prisma.team_members.create({
      data: {
        business_id: businessId,
        email: data.email,
        name: data.name,
        role: data.role,
        status: TeamMemberStatus.INVITED,
        invite_token: data.invite_token,
        invited_by: data.invited_by,
        invited_at: new Date(),
      },
    });
  }

  /**
   * Create the founding OWNER member for a newly created business.
   * Owners are ACTIVE immediately (no invite flow).
   */
  async createOwnerMember(
    businessId: string,
    data: { email: string; name: string; userId?: string },
  ): Promise<team_members> {
    return this.prisma.team_members.create({
      data: {
        ...(data.userId ? { id: data.userId } : {}),
        business_id: businessId,
        email: data.email,
        name: data.name,
        role: TeamMemberRole.OWNER,
        status: TeamMemberStatus.ACTIVE,
      },
    });
  }

  /**
   * Soft-delete a team member.
   */
  async softDeleteTeamMember(
    businessId: string,
    memberId: string,
  ): Promise<team_members> {
    return this.prisma.team_members.update({
      where: { id: memberId, business_id: businessId },
      data: {
        deleted_at: new Date(),
        status: TeamMemberStatus.SUSPENDED,
      },
    });
  }

  // ─────────────────────────────────────────────
  // Business Rules
  // ─────────────────────────────────────────────

  /**
   * Find active business rules, optionally filtered by rule type.
   */
  async findBusinessRules(
    businessId: string,
    type?: RuleType,
  ): Promise<business_rules[]> {
    return this.prisma.business_rules.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        is_active: true,
        ...(type ? { type } : {}),
      },
      orderBy: { priority: 'desc' },
    });
  }
}
