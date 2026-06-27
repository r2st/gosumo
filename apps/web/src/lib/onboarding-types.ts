// Types mirroring the backend onboarding module responses
// (apps/api/src/modules/onboarding). Kept local to the web app so the
// dashboard builds independently, per the project convention.

export type OnboardingStepId =
  | 'WELCOME'
  | 'CHANNELS'
  | 'CATALOG'
  | 'AI_CONFIG'
  | 'TEAM'
  | 'TEST';

export type OnboardingStepStatus = 'pending' | 'completed' | 'skipped';

export interface OnboardingStepDefinition {
  id: OnboardingStepId;
  title: string;
  description: string;
  optional: boolean;
}

export interface OnboardingStepState {
  step: OnboardingStepId;
  status: OnboardingStepStatus;
  definition: OnboardingStepDefinition;
  data: Record<string, unknown>;
  updatedAt: string | null;
}

export interface OnboardingProgress {
  steps: OnboardingStepState[];
  currentStep: OnboardingStepId | null;
  completedCount: number;
  skippedCount: number;
  totalSteps: number;
  percentComplete: number;
  isComplete: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OnboardingStatus {
  needed: boolean;
  isComplete: boolean;
  percentComplete: number;
  currentStep: OnboardingStepId | null;
  completedAt: string | null;
}

export interface OnboardingChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface OnboardingChatResponse {
  reply: string;
  suggestedQuestions: string[];
  source: 'ai' | 'fallback';
}

export interface UpdateOnboardingStepInput {
  step: OnboardingStepId;
  status?: OnboardingStepStatus;
  data?: Record<string, unknown>;
}

/** Canonical display order, matching the backend ONBOARDING_STEP_ORDER. */
export const ONBOARDING_STEP_ORDER: OnboardingStepId[] = [
  'WELCOME',
  'CHANNELS',
  'CATALOG',
  'AI_CONFIG',
  'TEAM',
  'TEST',
];
