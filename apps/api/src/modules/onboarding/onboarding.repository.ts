import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { businesses } from '@gosumo/database';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * OnboardingRepository — all Prisma access for the onboarding module.
 *
 * Onboarding state lives in `businesses.onboarding_progress` (JSONB). Every
 * query is scoped to a single business id and excludes soft-deleted rows.
 */
@Injectable()
export class OnboardingRepository {
  private readonly logger = new Logger(OnboardingRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Load a business (for existence checks + reading current progress). */
  async findBusinessById(businessId: string): Promise<businesses | null> {
    return this.prisma.businesses.findFirst({
      where: { id: businessId, deleted_at: null },
    });
  }

  /** Read the raw onboarding_progress JSON for a business, or null if missing. */
  async getProgress(businessId: string): Promise<unknown> {
    const business = await this.prisma.businesses.findFirst({
      where: { id: businessId, deleted_at: null },
      select: { onboarding_progress: true },
    });
    return business?.onboarding_progress ?? null;
  }

  /** Persist the full onboarding_progress JSON for a business. */
  async saveProgress(
    businessId: string,
    progress: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.businesses.update({
      where: { id: businessId },
      data: { onboarding_progress: progress as Prisma.InputJsonValue },
    });
  }
}
