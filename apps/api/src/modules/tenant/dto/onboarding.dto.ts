import { OnboardingStep } from '../tenant.constants';

/**
 * Onboarding status for a business: which steps are done, what's next, and
 * whether onboarding is complete.
 */
export interface OnboardingStatusResponse {
  /** Steps completed so far, in canonical order. */
  completedSteps: OnboardingStep[];
  /** The next step to complete, or null when onboarding is finished. */
  nextStep: OnboardingStep | null;
  /** All steps in order with a completed flag, for rendering a checklist. */
  steps: Array<{ step: OnboardingStep; completed: boolean }>;
  /** 0–100 completion percentage. */
  percentComplete: number;
  /** True once every step is complete. */
  isComplete: boolean;
}
