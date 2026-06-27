'use client';

import { useState } from 'react';
import { Rocket, Check, SkipForward, Circle } from 'lucide-react';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { useOnboardingProgress } from '@/hooks/use-onboarding';
import type { OnboardingStepStatus } from '@/lib/onboarding-types';

/**
 * Settings → Setup Wizard. Lets operators re-launch the guided onboarding at any
 * time and see which steps are done, skipped, or still pending.
 */
export default function SetupWizardSettingsPage() {
  const { data: progress, isLoading, isError, refetch } = useOnboardingProgress();
  const [open, setOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (isError || !progress) return <ErrorState onRetry={() => void refetch()} />;

  return (
    <>
      <SettingsCard
        title="Setup wizard"
        description="Re-run the guided setup to connect channels, build your catalog, and tune the AI."
        footer={
          <Button onClick={() => setOpen(true)}>
            <Rocket className="h-4 w-4" />
            {progress.isComplete ? 'Re-run setup wizard' : 'Continue setup'}
          </Button>
        }
      >
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.percentComplete}%` }} />
          </div>
          <span className="text-sm font-medium text-muted-foreground">{progress.percentComplete}%</span>
          {progress.isComplete && <Badge tone="success">Complete</Badge>}
        </div>

        <ul className="divide-y divide-border rounded-lg border border-border">
          {progress.steps.map((s) => (
            <li key={s.step} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <StatusIcon status={s.status} />
              <span className="flex-1">{s.definition.title}</span>
              <StatusBadge status={s.status} optional={s.definition.optional} />
            </li>
          ))}
        </ul>
      </SettingsCard>

      <OnboardingWizard open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function StatusIcon({ status }: { status: OnboardingStepStatus }) {
  if (status === 'completed') return <Check className="h-4 w-4 text-success" />;
  if (status === 'skipped') return <SkipForward className="h-4 w-4 text-muted-foreground" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

function StatusBadge({ status, optional }: { status: OnboardingStepStatus; optional: boolean }) {
  if (status === 'completed') return <Badge tone="success">Done</Badge>;
  if (status === 'skipped') return <Badge tone="warning">Skipped</Badge>;
  return <Badge tone="neutral">{optional ? 'Optional' : 'Required'}</Badge>;
}
