'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Check, PartyPopper } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { OnboardingStepper } from './onboarding-stepper';
import { OnboardingChat } from './onboarding-chat';
import { STEP_COMPONENTS } from './onboarding-steps';
import {
  useOnboardingProgress,
  useUpdateOnboardingStep,
  useCompleteOnboarding,
} from '@/hooks/use-onboarding';
import {
  ONBOARDING_STEP_ORDER,
  type OnboardingStepId,
  type OnboardingStepState,
} from '@/lib/onboarding-types';

const SUGGESTED: Record<OnboardingStepId, string[]> = {
  WELCOME: ['What timezone should I pick?', 'How do business hours affect the AI?'],
  CHANNELS: [
    'What WhatsApp number format do I need?',
    'How do I get a Meta Business verification?',
    'Which channel is easiest to start with?',
  ],
  CATALOG: ['How do I bulk-import my catalog?', 'What happens if a product is missing?'],
  AI_CONFIG: ['What do the confidence thresholds mean?', 'How should I describe my tone?'],
  TEAM: ['What can each role do?', 'How many members can I invite?'],
  TEST: ['How do I run a test?', 'My test failed — what now?'],
};

/**
 * OnboardingWizard — the full-screen guided setup experience: a step stepper, a
 * per-step form, and a contextual AI chat sidebar. Persists each step to the
 * backend and finishes by marking onboarding complete.
 */
export function OnboardingWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: progress, isLoading, isError, refetch } = useOnboardingProgress(open);
  const updateStep = useUpdateOnboardingStep();
  const complete = useCompleteOnboarding();

  const [activeStep, setActiveStep] = useState<OnboardingStepId>('WELCOME');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [finished, setFinished] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Reset initialisation whenever the wizard is (re)opened.
  useEffect(() => {
    if (!open) setInitialized(false);
  }, [open]);

  // Jump to the first incomplete step the first time progress loads per opening.
  useEffect(() => {
    if (open && progress && !initialized) {
      setActiveStep(progress.currentStep ?? 'WELCOME');
      setInitialized(true);
    }
  }, [open, progress, initialized]);

  const stepState: OnboardingStepState | undefined = useMemo(
    () => progress?.steps.find((s) => s.step === activeStep),
    [progress, activeStep],
  );

  // Load the active step's saved data into the editable draft.
  useEffect(() => {
    setDraft(stepState?.data ?? {});
  }, [activeStep, stepState?.updatedAt]);

  if (!open) return null;

  const close = () => {
    setFinished(false);
    onClose();
  };

  const activeIndex = ONBOARDING_STEP_ORDER.indexOf(activeStep);
  const isLast = activeIndex === ONBOARDING_STEP_ORDER.length - 1;
  const StepComponent = STEP_COMPONENTS[activeStep];

  /** Persist the current draft with a given status, then run a follow-up. */
  const persist = (status: 'completed' | 'skipped' | 'pending', then?: () => void) => {
    updateStep.mutate(
      { step: activeStep, status, data: draft },
      { onSuccess: () => then?.() },
    );
  };

  const goTo = (step: OnboardingStepId) => {
    // Save current edits without changing the step's status, then navigate.
    const currentStatus = stepState?.status ?? 'pending';
    updateStep.mutate(
      { step: activeStep, status: currentStatus, data: draft },
      { onSuccess: () => setActiveStep(step) },
    );
  };

  const next = () => {
    const target = ONBOARDING_STEP_ORDER[activeIndex + 1];
    persist('completed', () => target && setActiveStep(target));
  };

  const skip = () => {
    const target = ONBOARDING_STEP_ORDER[activeIndex + 1];
    persist('skipped', () => target && setActiveStep(target));
  };

  const finish = () => {
    persist('completed', () =>
      complete.mutate(undefined, { onSuccess: () => setFinished(true) }),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Onboarding setup wizard"
        className="relative z-10 flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-none border border-border bg-card shadow-2xl sm:h-[88vh] sm:rounded-xl"
      >
        {isLoading && <LoadingState label="Loading your setup…" className="flex-1" />}
        {isError && <ErrorState onRetry={() => void refetch()} className="flex-1" />}

        {progress && finished && <CompletedView onClose={close} />}

        {progress && !finished && (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[15rem_1fr_20rem]">
            {/* Stepper */}
            <aside className="hidden border-r border-border lg:block">
              <OnboardingStepper
                steps={progress.steps}
                activeStep={activeStep}
                onSelect={goTo}
                percentComplete={progress.percentComplete}
              />
            </aside>

            {/* Step content */}
            <section className="flex min-h-0 flex-col">
              <header className="flex items-start justify-between gap-4 border-b border-border p-5">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Step {activeIndex + 1} of {ONBOARDING_STEP_ORDER.length}
                  </p>
                  <h1 className="mt-0.5 text-lg font-bold tracking-tight">{stepState?.definition.title}</h1>
                  <p className="mt-0.5 text-sm text-muted-foreground">{stepState?.definition.description}</p>
                </div>
                <button onClick={close} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-5 w-5" />
                </button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
                {StepComponent && <StepComponent value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />}
              </div>

              <footer className="flex items-center justify-between gap-2 border-t border-border p-4">
                <Button
                  variant="ghost"
                  onClick={() => activeIndex > 0 && goTo(ONBOARDING_STEP_ORDER[activeIndex - 1]!)}
                  disabled={activeIndex === 0 || updateStep.isPending}
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <div className="flex items-center gap-2">
                  {complete.isError && (
                    <span className="text-xs text-danger">Finish the required steps first.</span>
                  )}
                  {stepState?.definition.optional && !isLast && (
                    <Button variant="outline" onClick={skip} disabled={updateStep.isPending}>
                      Skip
                    </Button>
                  )}
                  {isLast ? (
                    <Button onClick={finish} loading={updateStep.isPending || complete.isPending}>
                      <Check className="h-4 w-4" /> Finish setup
                    </Button>
                  ) : (
                    <Button onClick={next} loading={updateStep.isPending}>
                      Save & continue <ArrowRight className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </footer>
            </section>

            {/* AI chat */}
            <aside className="hidden min-h-0 border-l border-border lg:block">
              <OnboardingChat
                step={activeStep}
                stepTitle={stepState?.definition.title ?? ''}
                suggestedQuestions={SUGGESTED[activeStep]}
              />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function CompletedView({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
        <PartyPopper className="h-8 w-8" />
      </span>
      <div>
        <h2 className="text-xl font-bold tracking-tight">You&apos;re all set! 🎉</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Your GoSumo workspace is ready. You can revisit this setup anytime from Settings → Setup Wizard.
        </p>
      </div>
      <Button onClick={onClose}>Go to dashboard</Button>
    </div>
  );
}
