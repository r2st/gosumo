'use client';

import { CalendarCheck } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/states';
import { formatDateTimeIST } from '@/lib/format';
import { useLeadVisits } from '@/hooks/use-realty';
import {
  SITE_VISIT_STATUS_LABELS,
  SITE_VISIT_OUTCOME_LABELS,
  type SiteVisitStatus,
} from '@/lib/realty-types';

const STATUS_TONE: Record<SiteVisitStatus, BadgeTone> = {
  BOOKED: 'info',
  CONFIRMED: 'success',
  COMPLETED: 'success',
  NO_SHOW: 'danger',
  RESCHEDULED: 'warning',
  CANCELLED: 'neutral',
};

/** A lead's site-visit history — rendered inside the lead detail drawer. */
export function LeadVisitHistory({ leadId }: { leadId: string }) {
  const { data, isLoading, isError } = useLeadVisits(leadId);
  const visits = data?.data ?? [];

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <CalendarCheck className="h-4 w-4" />
        Site visits
      </h3>

      {isLoading ? (
        <div className="py-4">
          <Spinner />
        </div>
      ) : isError ? (
        <p className="py-3 text-xs text-muted-foreground">Could not load visits.</p>
      ) : visits.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">No site visits scheduled yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visits.map((v) => (
            <li key={v.id} className="rounded-lg border border-border bg-card p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{formatDateTimeIST(v.scheduledAt)}</span>
                <Badge tone={STATUS_TONE[v.status]}>{SITE_VISIT_STATUS_LABELS[v.status]}</Badge>
              </div>
              {v.outcome !== 'PENDING' && (
                <p className="mt-1 text-muted-foreground">
                  Outcome: {SITE_VISIT_OUTCOME_LABELS[v.outcome]}
                </p>
              )}
              {v.feedback && <p className="mt-1 text-muted-foreground">“{v.feedback}”</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
