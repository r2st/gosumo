import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { maskEmail } from '../../common/utils/log-redact.util';
import {
  Prisma,
  team_members,
  businesses,
  TeamMemberRole,
  TeamMemberStatus,
  AuthProvider,
} from '@prisma/client';

export type TeamMemberWithBusiness = team_members & {
  business: businesses;
};

@Injectable()
export class AuthRepository {
  private readonly logger = new Logger(AuthRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find a team member by email across all businesses.
   * Used for login — we need to find the user regardless of tenant.
   * Returns the team member with their business for JWT payload construction.
   */
  async findTeamMemberByEmail(email: string): Promise<TeamMemberWithBusiness | null> {
    return this.prisma.team_members.findFirst({
      where: {
        email: email.toLowerCase(),
        deleted_at: null,
      },
      include: {
        business: true,
      },
    });
  }

  /**
   * Find a team member by ID within a business.
   * Used for profile retrieval and token refresh — both of which already know
   * the tenant, either from the verified JWT or from the reset-token record.
   * Scoping here means a user id that has been moved to another business (or
   * simply guessed) cannot be read through a token minted for a different one.
   */
  async findTeamMemberById(
    businessId: string,
    id: string,
  ): Promise<TeamMemberWithBusiness | null> {
    return this.prisma.team_members.findFirst({
      where: {
        id,
        business_id: businessId,
        deleted_at: null,
      },
      include: {
        business: true,
      },
    });
  }

  /**
   * Create a new business and its first team member (OWNER) in a transaction.
   * Used during registration.
   */
  async createTeamMemberWithBusiness(
    email: string,
    name: string,
    passwordHash: string,
    businessName: string,
    slug: string,
  ): Promise<TeamMemberWithBusiness> {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.businesses.create({
        data: {
          name: businessName,
          slug,
          email: email.toLowerCase(),
        },
      });

      const teamMember = await tx.team_members.create({
        data: {
          business_id: business.id,
          email: email.toLowerCase(),
          name,
          password_hash: passwordHash,
          role: TeamMemberRole.OWNER,
          status: TeamMemberStatus.ACTIVE,
        },
        include: {
          business: true,
        },
      });

      this.logger.log(
        `Created business '${businessName}' (${business.id}) with owner ${maskEmail(email)}`,
      );

      return teamMember;
    });
  }

  /**
   * Find a team member by their Google account id. Used for OAuth login.
   */
  async findTeamMemberByGoogleId(googleId: string): Promise<TeamMemberWithBusiness | null> {
    return this.prisma.team_members.findFirst({
      where: {
        google_id: googleId,
        deleted_at: null,
      },
      include: {
        business: true,
      },
    });
  }

  /**
   * Link a Google account to an existing (local) team member, returning the
   * refreshed record with its business. Used when a user who registered with a
   * password later signs in with Google using the same email.
   */
  async linkGoogleAccount(
    businessId: string,
    id: string,
    googleId: string,
    avatarUrl: string | null,
  ): Promise<TeamMemberWithBusiness> {
    return this.prisma.team_members.update({
      where: { id, business_id: businessId },
      data: {
        google_id: googleId,
        auth_provider: AuthProvider.GOOGLE,
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      },
      include: {
        business: true,
      },
    });
  }

  /**
   * Create a new business and its first team member (OWNER) from a Google
   * profile — no password is stored. Used for first-time OAuth sign-ups.
   */
  async createOAuthTeamMemberWithBusiness(
    email: string,
    name: string,
    businessName: string,
    slug: string,
    googleId: string,
    avatarUrl: string | null,
  ): Promise<TeamMemberWithBusiness> {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.businesses.create({
        data: {
          name: businessName,
          slug,
          email: email.toLowerCase(),
        },
      });

      const teamMember = await tx.team_members.create({
        data: {
          business_id: business.id,
          email: email.toLowerCase(),
          name,
          avatar_url: avatarUrl,
          role: TeamMemberRole.OWNER,
          status: TeamMemberStatus.ACTIVE,
          auth_provider: AuthProvider.GOOGLE,
          google_id: googleId,
        },
        include: {
          business: true,
        },
      });

      this.logger.log(
        `Created business '${businessName}' (${business.id}) via Google for ${maskEmail(email)}`,
      );

      return teamMember;
    });
  }

  /**
   * Partial update of a team member record.
   */
  async updateTeamMember(
    businessId: string,
    id: string,
    data: Prisma.team_membersUpdateInput,
  ): Promise<team_members> {
    return this.prisma.team_members.update({
      where: { id, business_id: businessId },
      data,
    });
  }

  /**
   * Update last login timestamp and increment login count.
   */
  async updateLastLogin(businessId: string, id: string): Promise<void> {
    await this.prisma.team_members.update({
      where: { id, business_id: businessId },
      data: {
        last_login_at: new Date(),
        login_count: { increment: 1 },
      },
    });
  }

  /**
   * Check if a business slug already exists.
   */
  async isSlugTaken(slug: string): Promise<boolean> {
    const existing = await this.prisma.businesses.findUnique({
      where: { slug },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * Check if a business email already exists.
   */
  async isBusinessEmailTaken(email: string): Promise<boolean> {
    const existing = await this.prisma.businesses.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });
    return existing !== null;
  }
}
