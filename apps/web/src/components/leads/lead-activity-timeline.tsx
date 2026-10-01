'use client';

import {
  Brain,
  CalendarCheck,
  Clock,
  Flag,
  Hand,
  MessageCircle,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Spinner } from '@/components/ui/states';
import { formatDateTimeIST } from '@/lib/format';
import { useLeadVisits } from '@/hooks/use-realty';
import { buildLeadTimeline, type LeadTimelineKind } from '@/lib/lead-timeline';
import { cn } from '@/lib/utils';
import type { Lead } from '@/lib/realty-types';

const KIND_ICON: Record<LeadTimelineKind, LucideIcon> = {
  captured: UserPlus,
  contact: MessageCircle,
  fact: Brain,
  objection: Hand,
  promise: Flag,
  visit: CalendarCheck,
  stage: Sparkles,
  activity: Clock,
  followup: Clock,
};

const KIND_TONE: Record<LeadTimelineKind, string> = {
  captured: 'bg-primary/15 text-primary',
  contact: 'bg-sky-500/15 text-sky-400',
  fact: 'bg-sky-500/15 text-sky-400',
  objection: 'bg-amber-500/15 text-amber-400',
  promise: 'bg-emerald-500/15 text-emerald-400',
  visit: 'bg-violet-500/15 text-violet-400',
  stage: 'bg-primary/15 text-primary',
  activity: 'bg-muted text-muted-foreground',
  followup: 'bg-amber-500/15 text-amber-400',
};

/**
 * Vertical activity timeline for a lead — conversation memory, stage changes,
 * site visits, and lifecycle moments merged into one newest-first stream.
 */
export function LeadActivityTimeline({ lead }: { lead: Lead }) {
  const { data, isLoading } = useLeadVisits(lead.id);
  const visits = data?.data ?? [];
  const events = buildLeadTimeline(lead, visits);

  if (isLoading && events.length === 0) {
    return (
      <div className="py-6">
        <Spinner />
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="py-3 text-xs text-muted-foreground">No activity recorded yet.</p>;
  }

  return (
    <ol className="relative flex flex-col gap-4">
      {events.map((e, i) => {
        const Icon = KIND_ICON[e.kind];
        const isLast = i === events.length - 1;
        return (
          <li key={e.id} className="relative flex gap-3">
            {/* Connector line between nodes */}
            {!isLast && <span className="absolute left-[15px] top-8 h-full w-px bg-border" aria-hidden />}
            <span
              className={cn(
                'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                KIND_TONE[e.kind],
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-x-2">
                <p className="text-sm font-medium text-foreground">{e.title}</p>
                {e.future && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                    Upcoming
                  </span>
                )}
              </div>
              {e.detail && <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p>}
              <p className="mt-0.5 text-[11px] text-muted-foreground">{formatDateTimeIST(e.at)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
