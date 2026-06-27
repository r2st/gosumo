import {
  IsArray,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  OnboardingStepId,
  OnboardingStepStatus,
  OnboardingStepDefinition,
} from '../onboarding.constants';

/**
 * Update a single onboarding step. Used by `PUT /onboarding/progress`.
 *
 * `status` defaults to COMPLETED when omitted (the common "Next" action).
 * Pass SKIPPED to explicitly record that the operator chose to skip the step,
 * or PENDING to reopen it. `data` is the step's collected form payload (e.g. the
 * confirmed profile fields, AI tone) and is merged into the stored step data.
 */
export class UpdateProgressDto {
  @IsEnum(OnboardingStepId)
  step!: OnboardingStepId;

  @IsOptional()
  @IsEnum(OnboardingStepStatus)
  status?: OnboardingStepStatus;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

/** A single chat turn passed back for conversational context. */
export class OnboardingChatMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;
}

/**
 * Ask the onboarding AI assistant a question. Used by `POST /onboarding/chat`.
 */
export class OnboardingChatDto {
  @IsString()
  @MaxLength(2000)
  message!: string;

  /** The wizard step the user is currently on, for grounding the answer. */
  @IsOptional()
  @IsEnum(OnboardingStepId)
  step?: OnboardingStepId;

  /** Prior turns (most recent last); the service trims to a small window. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingChatMessageDto)
  history?: OnboardingChatMessageDto[];
}

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────

export interface OnboardingStepState {
  step: OnboardingStepId;
  status: OnboardingStepStatus;
  /** Step metadata (title/description/optional) for rendering. */
  definition: OnboardingStepDefinition;
  /** Operator-collected payload for this step. */
  data: Record<string, unknown>;
  updatedAt: string | null;
}

export interface OnboardingProgressResponse {
  steps: OnboardingStepState[];
  /** The first not-yet-completed step, or null when all are done. */
  currentStep: OnboardingStepId | null;
  completedCount: number;
  skippedCount: number;
  totalSteps: number;
  percentComplete: number;
  isComplete: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OnboardingStatusResponse {
  /** True when the wizard should be shown (not yet completed). */
  needed: boolean;
  isComplete: boolean;
  percentComplete: number;
  currentStep: OnboardingStepId | null;
  completedAt: string | null;
}

export interface OnboardingChatResponse {
  reply: string;
  /** Follow-up questions to surface as quick chips. */
  suggestedQuestions: string[];
  /** Whether the reply came from the LLM or the static fallback. */
  source: 'ai' | 'fallback';
}
