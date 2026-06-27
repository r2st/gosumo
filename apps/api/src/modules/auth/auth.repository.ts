import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { Prisma, team_members, businesses, TeamMemberRole, TeamMemberStatus } from '@prisma/client';

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
   * Find a team member by ID.
   * Used for profile retrieval and token refresh.
   */
  async findTeamMemberById(id: string): Promise<TeamMemberWithBusiness | null> {
    return this.prisma.team_members.findFirst({
      where: {
        id,
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
        `Created business '${businessName}' (${business.id}) with owner ${email}`,
      );

      return teamMember;
    });
  }

  /**
   * Partial update of a team member record.
   */
  async updateTeamMember(
    id: string,
    data: Prisma.team_membersUpdateInput,
  ): Promise<team_members> {
    return this.prisma.team_members.update({
      where: { id },
      data,
    });
  }

  /**
   * Update last login timestamp and increment login count.
   */
  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.team_members.update({
      where: { id },
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
