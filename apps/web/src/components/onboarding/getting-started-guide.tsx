'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useDashboardMetrics } from '@/hooks/use-queries';
import { useChannels, useTeam } from '@/hooks/use-settings';

const DISMISS_KEY = 'desk:guide:dismissed';
const SHARED_KEY = 'desk:guide:shared-link';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* storage unavailable — the guide simply forgets */
  }
}

/** Called by the support-link card when the operator copies or shares the link. */
export function markSupportLinkShared(): void {
  writeFlag(SHARED_KEY);
  window.dispatchEvent(new Event('desk:guide'));
}

export interface GuideSignals {
  channelConnected: boolean;
  linkShared: boolean;
  ticketReceived: boolean;
  replied: boolean;
  teamInvited: boolean;
}

export interface GuideStep {
  id: keyof GuideSignals;
  title: string;
  body: string;
  href: string;
  cta: string;
  done: boolean;
}

/**
 * The first-run checklist. Each step is ticked off by what the account has
 * actually done — a connected channel, a ticket in the inbox, a second team
 * member — rather than by clicking "done", so it cannot drift from reality.
 * Sharing the link is the one thing the API cannot see, so that step reads a
 * local flag.
 */
export function buildGuideSteps(s: GuideSignals): GuideStep[] {
  return [
    {
      id: 'channelConnected',
      title: 'Connect a channel',
      body: 'Web Chat works instantly; WhatsApp, email and Instagram take a few minutes.',
      href: '/settings/channels',
      cta: 'Connect',
      done: s.channelConnected,
    },
    {
      id: 'linkShared',
      title: 'Share your support link',
      body: 'Customers raise tickets from it without signing up. Send it on WhatsApp.',
      href: '#support-link',
      cta: 'Get link',
      done: s.linkShared,
    },
    {
      id: 'ticketReceived',
      title: 'Receive your first ticket',
      body: 'Open your support link on your phone and raise a test ticket.',
      href: '/conversations',
      cta: 'Open inbox',
      done: s.ticketReceived,
    },
    {
      id: 'replied',
      title: 'Reply to a customer',
      body: 'Answer yourself or approve an AI draft — both count.',
      href: '/conversations',
      cta: 'Reply',
      done: s.replied,
    },
    {
      id: 'teamInvited',
      title: 'Invite a teammate',
      body: 'New tickets are routed to whoever is available.',
      href: '/settings/team',
      cta: 'Invite',
      done: s.teamInvited,
    },
  ];
}

export function GettingStartedGuide() {
  const channelsQ = useChannels();
  const teamQ = useTeam();
  const metricsQ = useDashboardMetrics();
  const [dismissed, setDismissed] = useState(true);
  const [linkShared, setLinkShared] = useState(false);

  useEffect(() => {
    setDismissed(readFlag(DISMISS_KEY));
    setLinkShared(readFlag(SHARED_KEY));
    const sync = () => setLinkShared(readFlag(SHARED_KEY));
    window.addEventListener('desk:guide', sync);
    return () => window.removeEventListener('desk:guide', sync);
  }, []);

  if (dismissed || channelsQ.isLoading || metricsQ.isLoading) return null;

  const m = metricsQ.data;
  const steps = buildGuideSteps({
    channelConnected: !!channelsQ.data?.data.some((c) => c.status === 'CONNECTED'),
    linkShared,
    ticketReceived: (m?.conversations.total ?? 0) > 0,
    replied: (m?.messages.outbound ?? 0) > 0,
    teamInvited: (teamQ.data?.data.length ?? 0) > 1,
  });
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  const dismiss = () => {
    writeFlag(DISMISS_KEY);
    setDismissed(true);
  };

  return (
    <Card aria-labelledby="guide-title">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle id="guide-title">Get started with DoAide Desk</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {doneCount} of {steps.length} done · about 10 minutes in total
          </p>
          <div
            className="mt-2 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={doneCount}
            aria-label="Setup progress"
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={dismiss} aria-label="Hide getting started guide">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="divide-y divide-border">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-3 py-3">
              {step.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-label="Done" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="To do" />
              )}
              <div className="min-w-0 flex-1">
                <p className={step.done ? 'text-sm font-medium text-muted-foreground line-through' : 'text-sm font-medium text-foreground'}>
                  {step.title}
                </p>
                {!step.done && <p className="text-xs text-muted-foreground">{step.body}</p>}
              </div>
              {!step.done && (
                <Link
                  href={step.href}
                  className="inline-flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted max-sm:h-12 max-sm:px-4"
                >
                  {step.cta}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
