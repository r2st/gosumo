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

  /**
   * Merge `patch` into `profile.settings` in the database, and return the
   * resulting settings object.
   *
   * Read-modify-write on a JSONB column loses concurrent writes, and this one
   * column is written by more than the settings screen. `PATCH /business/settings`
   * read the whole `profile`, spread the patch over `profile.settings` in
   * process, and wrote the whole `profile` back — so a save that overlapped
   * with any other writer of `profile` silently discarded whichever landed
   * first. That is not a theoretical window: `suspendBusiness` and
   * `activateBusiness` write `profile.suspendedAt` / `suspendedReason` the same
   * way, so an ops suspension racing a manager's settings save could restore
   * the profile the suspension had just marked — leaving a business flagged
   * inactive with no record of why. Two managers on the settings screen is the
   * ordinary case: one saves office hours, the other saves a greeting a moment
   * later, and the office hours are gone with nothing in any log.
   *
   * Doing the merge in Postgres removes the window entirely rather than
   * narrowing it. `||` merges at the top level of `settings`, which is the same
   * shallow merge the in-process spread performed — `officeHours` is replaced
   * wholesale, not deep-merged, exactly as before. Keys the patch does not
   * mention are untouched, and so are the *other* keys of `profile`, which is
   * the part read-modify-write could not promise.
   *
   * `updated_at` is set explicitly: Prisma's `@updatedAt` is applied by the
   * client, so a raw statement bypasses it and would leave the column stale.
   */
  async mergeProfileSettings(
    businessId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.prisma.$queryRaw<Array<{ settings: unknown }>>`
      UPDATE businesses
         SET profile = jsonb_set(
               COALESCE(profile, '{}'::jsonb),
               '{settings}',
               COALESCE(profile -> 'settings', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
               true
             ),
             updated_at = NOW()
       WHERE id = ${businessId}::uuid AND deleted_at IS NULL
      RETURNING profile -> 'settings' AS settings
    `;

    const row = rows[0];
    if (!row) return null;
    return (row.settings ?? {}) as Record<string, unknown>;
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
   * Count the business's owners.
   *
   * INVITED owners count: an invite that has been sent but not yet accepted
   * still represents a recoverable path back into the business, and treating
   * it as absent would let the *accepted* owner be removed on the strength of
   * an invite that may never be taken up.
   */
  async countOwners(businessId: string): Promise<number> {
    return this.prisma.team_members.count({
      where: {
        business_id: businessId,
        role: TeamMemberRole.OWNER,
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
   * The subset of `memberIds` that are live, ACTIVE members of this business.
   * One query for a whole candidate list.
   */
  async findAssignableTeamMembers(
    businessId: string,
    memberIds: string[],
  ): Promise<Array<{ id: string }>> {
    if (memberIds.length === 0) return [];
    return this.prisma.team_members.findMany({
      where: {
        id: { in: memberIds },
        business_id: businessId,
        status: TeamMemberStatus.ACTIVE,
        deleted_at: null,
      },
      select: { id: true },
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
