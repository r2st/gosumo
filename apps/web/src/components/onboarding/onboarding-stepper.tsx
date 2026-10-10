'use client';

import { Check, Circle, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OnboardingStepState, OnboardingStepId } from '@/lib/onboarding-types';

/**
 * Vertical progress stepper for the onboarding wizard. Shows each step's status
 * (completed / skipped / pending) and lets the user jump to any step.
 */
export function OnboardingStepper({
  steps,
  activeStep,
  onSelect,
  percentComplete,
}: {
  steps: OnboardingStepState[];
  activeStep: OnboardingStepId;
  onSelect: (step: OnboardingStepId) => void;
  percentComplete: number;
}) {
  return (
    <div className="flex h-full flex-col gap-5 p-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Getting started</p>
        <h2 className="mt-1 text-lg font-bold tracking-tight">Set up GoSumo Realty</h2>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percentComplete}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{percentComplete}% complete</p>
      </div>

      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => {
          const active = s.step === activeStep;
          return (
            <li key={s.step}>
              <button
                type="button"
                onClick={() => onSelect(s.step)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                  active ? 'bg-primary/10' : 'hover:bg-muted',
                )}
              >
                <StepIcon status={s.status} index={i} active={active} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium', active ? 'text-foreground' : 'text-foreground/90')}>
                    {s.definition.title}
                  </span>
                  <span className="mt-0.5 block text-xs capitalize text-muted-foreground">
                    {s.status === 'pending' ? (s.definition.optional ? 'Optional' : 'Required') : s.status}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepIcon({
  status,
  index,
  active,
}: {
  status: OnboardingStepState['status'];
  index: number;
  active: boolean;
}) {
  const base = 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold';
  if (status === 'completed') {
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground')}>
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')}>
        <SkipForward className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        active ? 'border-2 border-primary text-primary' : 'border border-border text-muted-foreground',
      )}
    >
      {active ? <Circle className="h-2.5 w-2.5 fill-current" /> : index + 1}
    </span>
  );
}
