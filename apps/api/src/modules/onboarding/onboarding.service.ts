import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnboardingRepository } from './onboarding.repository';
import {
  OnboardingStepId,
  OnboardingStepStatus,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_ORDER,
  REQUIRED_STEPS,
} from './onboarding.constants';
import {
  UpdateProgressDto,
  OnboardingProgressResponse,
  OnboardingStatusResponse,
  OnboardingStepState,
} from './dto';

/** Internal persisted shape of a single step. */
interface StoredStep {
  status: OnboardingStepStatus;
  data: Record<string, unknown>;
  updatedAt: string | null;
}

/** Internal persisted shape of `businesses.onboarding_progress`. */
interface StoredProgress {
  version: number;
  startedAt: string | null;
  completedAt: string | null;
  steps: Partial<Record<OnboardingStepId, StoredStep>>;
}

const PROGRESS_VERSION = 1;

/**
 * OnboardingService — drives the guided 6-step onboarding wizard.
 *
 * State is persisted in `businesses.onboarding_progress`. Unlike the legacy
 * tenant checklist, steps may be completed in any order and skips are tracked
 * explicitly. `complete()` requires all mandatory steps (currently the business
 * profile) to be done. Emits `onboarding.wizard.*` events.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly repository: OnboardingRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Full wizard progress for the dashboard. */
  async getProgress(businessId: string): Promise<OnboardingProgressResponse> {
    const stored = await this.loadProgress(businessId);
    return this.buildProgressResponse(stored);
  }

  /** Lightweight status check used on login to decide whether to show the wizard. */
  async getStatus(businessId: string): Promise<OnboardingStatusResponse> {
    const stored = await this.loadProgress(businessId);
    const progress = this.buildProgressResponse(stored);
    return {
      needed: !progress.isComplete,
      isComplete: progress.isComplete,
      percentComplete: progress.percentComplete,
      currentStep: progress.currentStep,
      completedAt: progress.completedAt,
    };
  }

  /**
   * Update one step's status and/or collected data. Status defaults to
   * COMPLETED. Returns the recomputed progress. Idempotent for repeated
   * identical updates (still persists merged data).
   */
  async updateProgress(
    businessId: string,
    dto: UpdateProgressDto,
  ): Promise<OnboardingProgressResponse> {
    if (!ONBOARDING_STEP_ORDER.includes(dto.step)) {
      throw new BadRequestException(`Unknown onboarding step: ${dto.step}`);
    }

    const stored = await this.loadProgress(businessId);
    const status = dto.status ?? OnboardingStepStatus.COMPLETED;
    const now = new Date().toISOString();

    const existing = stored.steps[dto.step];
    stored.steps[dto.step] = {
      status,
      data: { ...(existing?.data ?? {}), ...(dto.data ?? {}) },
      updatedAt: now,
    };
    if (!stored.startedAt) {
      stored.startedAt = now;
    }

    await this.repository.saveProgress(businessId, stored as unknown as Record<string, unknown>);

    this.eventEmitter.emit('onboarding.wizard.step.updated', {
      businessId,
      step: dto.step,
      status,
      timestamp: now,
    });
    this.logger.log(`Onboarding step ${dto.step} → ${status} for ${businessId}`);

    return this.buildProgressResponse(stored);
  }

  /**
   * Mark onboarding complete. Requires every mandatory step to be COMPLETED;
   * any still-PENDING optional steps are recorded as SKIPPED so the dashboard
   * can surface them later. Emits `onboarding.wizard.completed`.
   */
  async complete(businessId: string): Promise<OnboardingProgressResponse> {
    const stored = await this.loadProgress(businessId);

    const missingRequired = REQUIRED_STEPS.filter(
      (step) => stored.steps[step]?.status !== OnboardingStepStatus.COMPLETED,
    );
    if (missingRequired.length > 0) {
      throw new BadRequestException(
        `Cannot complete onboarding — required step(s) not done: ${missingRequired.join(', ')}`,
      );
    }

    const now = new Date().toISOString();
    // Any optional step left untouched is treated as skipped on finish.
    for (const step of ONBOARDING_STEP_ORDER) {
      if (!stored.steps[step] || stored.steps[step]?.status === OnboardingStepStatus.PENDING) {
        stored.steps[step] = {
          status: OnboardingStepStatus.SKIPPED,
          data: stored.steps[step]?.data ?? {},
          updatedAt: now,
        };
      }
    }
    stored.completedAt = now;
    if (!stored.startedAt) stored.startedAt = now;

    await this.repository.saveProgress(businessId, stored as unknown as Record<string, unknown>);

    this.eventEmitter.emit('onboarding.wizard.completed', {
      businessId,
      timestamp: now,
    });
    this.logger.log(`Onboarding completed for ${businessId}`);

    return this.buildProgressResponse(stored);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /** Load + normalize stored progress, throwing if the business is missing. */
  private async loadProgress(businessId: string): Promise<StoredProgress> {
    const business = await this.repository.findBusinessById(businessId);
    if (!business) {
      throw new NotFoundException(`Business not found: ${businessId}`);
    }
    return this.normalize(business.onboarding_progress);
  }

  /** Coerce arbitrary stored JSON into a well-formed StoredProgress. */
  private normalize(raw: unknown): StoredProgress {
    const obj = this.toRecord(raw);
    const stepsRaw = this.toRecord(obj['steps']);
    const steps: Partial<Record<OnboardingStepId, StoredStep>> = {};

    for (const step of ONBOARDING_STEP_ORDER) {
      const entry = this.toRecord(stepsRaw[step]);
      const status = this.toStatus(entry['status']);
      if (status === null && Object.keys(entry).length === 0) {
        continue; // untouched step
      }
      steps[step] = {
        status: status ?? OnboardingStepStatus.PENDING,
        data: this.toRecord(entry['data']),
        updatedAt: typeof entry['updatedAt'] === 'string' ? (entry['updatedAt'] as string) : null,
      };
    }

    return {
      version: PROGRESS_VERSION,
      startedAt: typeof obj['startedAt'] === 'string' ? (obj['startedAt'] as string) : null,
      completedAt: typeof obj['completedAt'] === 'string' ? (obj['completedAt'] as string) : null,
      steps,
    };
  }

  private buildProgressResponse(stored: StoredProgress): OnboardingProgressResponse {
    const steps: OnboardingStepState[] = ONBOARDING_STEP_ORDER.map((step) => {
      const entry = stored.steps[step];
      return {
        step,
        status: entry?.status ?? OnboardingStepStatus.PENDING,
        definition: ONBOARDING_STEPS[step],
        data: entry?.data ?? {},
        updatedAt: entry?.updatedAt ?? null,
      };
    });

    const completedCount = steps.filter((s) => s.status === OnboardingStepStatus.COMPLETED).length;
    const skippedCount = steps.filter((s) => s.status === OnboardingStepStatus.SKIPPED).length;
    const totalSteps = ONBOARDING_STEP_ORDER.length;
    const currentStep =
      steps.find((s) => s.status === OnboardingStepStatus.PENDING)?.step ?? null;
    const percentComplete = Math.round((completedCount / totalSteps) * 100);
    const isComplete = stored.completedAt !== null;

    return {
      steps,
      currentStep,
      completedCount,
      skippedCount,
      totalSteps,
      percentComplete,
      isComplete,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
    };
  }

  private toStatus(value: unknown): OnboardingStepStatus | null {
    return value === OnboardingStepStatus.COMPLETED ||
      value === OnboardingStepStatus.SKIPPED ||
      value === OnboardingStepStatus.PENDING
      ? (value as OnboardingStepStatus)
      : null;
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }
}
