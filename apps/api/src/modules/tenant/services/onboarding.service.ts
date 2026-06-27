import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { TenantRepository } from '../tenant.repository';
import {
  OnboardingStep,
  ONBOARDING_STEP_ORDER,
} from '../tenant.constants';
import { OnboardingStatusResponse } from '../dto/onboarding.dto';

/**
 * OnboardingService — tracks a business's progress through the ordered
 * onboarding checklist (PROFILE → CHANNEL → AI_CONFIG → POLICIES → TEAM).
 *
 * Progress is stored under `businesses.profile.onboarding.completedSteps`.
 * Steps must be completed in order; completing the final step emits
 * `business.onboarding.completed`, signalling the tenant can be activated.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly repository: TenantRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Current onboarding status for a business.
   */
  async getOnboardingStatus(businessId: string): Promise<OnboardingStatusResponse> {
    const business = await this.getBusinessOrThrow(businessId);
    const completed = this.readCompletedSteps(business.profile);
    return this.buildStatus(completed);
  }

  /**
   * Mark an onboarding step complete.
   *
   * Steps must be completed in canonical order — attempting to skip ahead
   * throws BadRequestException (`INVALID_ONBOARDING_STEP`). Re-completing an
   * already-done step is idempotent. Emits `business.onboarding.step.completed`
   * and, when the last step lands, `business.onboarding.completed`.
   */
  async completeStep(
    businessId: string,
    step: OnboardingStep,
  ): Promise<OnboardingStatusResponse> {
    if (!ONBOARDING_STEP_ORDER.includes(step)) {
      throw new BadRequestException(`Unknown onboarding step: ${step}`);
    }

    const business = await this.getBusinessOrThrow(businessId);
    const completed = this.readCompletedSteps(business.profile);

    // Idempotent: already done.
    if (completed.includes(step)) {
      return this.buildStatus(completed);
    }

    // Enforce sequential completion — the step must be the next expected one.
    const nextExpected = ONBOARDING_STEP_ORDER.find((s) => !completed.includes(s));
    if (step !== nextExpected) {
      throw new BadRequestException(
        `INVALID_ONBOARDING_STEP: expected "${nextExpected}" next but got "${step}"`,
      );
    }

    const updatedSteps = [...completed, step];
    const status = this.buildStatus(updatedSteps);

    const profile = this.toRecord(business.profile);
    const onboarding = this.toRecord(profile['onboarding']);
    onboarding['completedSteps'] = updatedSteps;
    if (status.isComplete) {
      onboarding['completedAt'] = new Date().toISOString();
    }
    profile['onboarding'] = onboarding;

    await this.repository.updateBusiness(businessId, {
      profile: profile as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.onboarding.step.completed', {
      businessId,
      step,
      percentComplete: status.percentComplete,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `Onboarding step "${step}" completed for ${businessId} (${status.percentComplete}%)`,
    );

    if (status.isComplete) {
      this.eventEmitter.emit('business.onboarding.completed', {
        businessId,
        timestamp: new Date().toISOString(),
      });
      this.logger.log(`Onboarding completed for ${businessId}`);
    }

    return status;
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private buildStatus(completed: OnboardingStep[]): OnboardingStatusResponse {
    const ordered = ONBOARDING_STEP_ORDER.filter((s) => completed.includes(s));
    const nextStep = ONBOARDING_STEP_ORDER.find((s) => !completed.includes(s)) ?? null;
    const steps = ONBOARDING_STEP_ORDER.map((step) => ({
      step,
      completed: completed.includes(step),
    }));
    const percentComplete = Math.round(
      (ordered.length / ONBOARDING_STEP_ORDER.length) * 100,
    );

    return {
      completedSteps: ordered,
      nextStep,
      steps,
      percentComplete,
      isComplete: nextStep === null,
    };
  }

  private readCompletedSteps(profile: unknown): OnboardingStep[] {
    const onboarding = this.toRecord(this.toRecord(profile)['onboarding']);
    const raw = onboarding['completedSteps'];
    if (!Array.isArray(raw)) {
      return [];
    }
    // Keep only known steps, deduplicated.
    const known = new Set(ONBOARDING_STEP_ORDER);
    const seen = new Set<OnboardingStep>();
    for (const value of raw) {
      if (typeof value === 'string' && known.has(value as OnboardingStep)) {
        seen.add(value as OnboardingStep);
      }
    }
    return ONBOARDING_STEP_ORDER.filter((s) => seen.has(s));
  }

  private async getBusinessOrThrow(businessId: string) {
    const business = await this.repository.findBusinessById(businessId);
    if (!business) {
      throw new NotFoundException(`Business not found: ${businessId}`);
    }
    return business;
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }
}
