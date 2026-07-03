'use client';

import { useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/states';
import { useMatchForLead } from '@/hooks/use-realty';
import { paiseToCompactRupees } from '@/lib/format';
import { matchBorder, matchTone } from '@/lib/realty-ui';
import { cn } from '@/lib/utils';
import type { Lead } from '@/lib/realty-types';

/**
 * Verified inventory units ranked by fit against a lead's BLTC requirement.
 * Runs the match on mount; shared shape with the dossier's matched-units list.
 */
export function LeadMatchedUnits({ lead, limit = 8 }: { lead: Lead; limit?: number }) {
  const match = useMatchForLead();
  const runMatch = match.mutate;
  const units = match.data ?? [];

  useEffect(() => {
    runMatch({ id: lead.id, limit });
  }, [lead.id, limit, runMatch]);

  if (match.isPending) {
    return (
      <div className="py-6">
        <Spinner />
      </div>
    );
  }

  if (match.isError) {
    return <p className="py-4 text-xs text-muted-foreground">Could not compute matches.</p>;
  }

  if (units.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
        No verified units match this buyer&apos;s requirement yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {units.map((u) => (
        <li
          key={u.unitId}
          className={cn('rounded-lg border border-l-4 border-border bg-card p-3 shadow-sm', matchBorder(u.fitScore))}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{u.projectName}</p>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                {u.config} · {u.locality}
              </p>
            </div>
            <Badge tone={matchTone(u.fitScore)} className="shrink-0">
              {u.fitScore}% match
            </Badge>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{paiseToCompactRupees(u.allInPricePaise)}</span>
            {u.reasons.length > 0 && (
              <span className="truncate text-[11px] text-muted-foreground" title={u.reasons.join(' · ')}>
                {u.reasons[0]}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
