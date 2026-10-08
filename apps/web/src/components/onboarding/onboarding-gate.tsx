'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { useOnboardingStatus } from '@/hooks/use-onboarding';
import { OnboardingWizard } from './onboarding-wizard';

const DISMISS_KEY = 'desk:onboarding:dismissed';

/**
 * OnboardingGate — checks onboarding status once the user is authenticated and
 * auto-opens the wizard immediately after first login/signup. If the operator
 * closes it without finishing, it won't re-pop this browser session (they can
 * relaunch from Settings → Setup Wizard). Mounted inside the dashboard shell.
 */
export function OnboardingGate() {
  const { status: authStatus } = useAuth();
  const authed = authStatus === 'authenticated';
  const { data: status } = useOnboardingStatus(authed);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!authed || !status?.needed) return;
    const dismissed = typeof window !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1';
    if (!dismissed) setOpen(true);
  }, [authed, status?.needed]);

  const close = () => {
    setOpen(false);
    if (typeof window !== 'undefined') sessionStorage.setItem(DISMISS_KEY, '1');
  };

  if (!authed) return null;
  return <OnboardingWizard open={open} onClose={close} />;
}
