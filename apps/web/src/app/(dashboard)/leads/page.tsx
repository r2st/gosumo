'use client';

import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { LeadCard } from '@/components/leads/lead-card';
import { useLeads, useLeadBoard } from '@/hooks/use-realty';
import { LEAD_STAGES, STAGE_LABELS, type Lead, type LeadStage } from '@/lib/realty-types';

export default function LeadsPage() {
  const boardQ = useLeadBoard();
  // Pull a generous page of leads and group them into columns client-side.
  const leadsQ = useLeads({ limit: 100 });

  const counts = useMemo(() => {
    const map: Partial<Record<LeadStage, number>> = {};
    for (const col of boardQ.data ?? []) map[col.stage] = col.count;
    return map;
  }, [boardQ.data]);

  const byStage = useMemo(() => {
    const map: Record<LeadStage, Lead[]> = {
      NEW: [], CONTACTED: [], QUALIFIED: [], VISIT_BOOKED: [], VISITED: [],
      NEGOTIATING: [], CLOSED_WON: [], CLOSED_LOST: [], DORMANT: [],
    };
    for (const lead of leadsQ.data?.data ?? []) map[lead.stage]?.push(lead);
    return map;
  }, [leadsQ.data]);

  const isLoading = boardQ.isLoading || leadsQ.isLoading;
  const isError = boardQ.isError || leadsQ.isError;
  const total = (leadsQ.data?.data ?? []).length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Leads"
        description="Your AI-managed pipeline — every buyer captured, qualified, and followed up."
      />

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {isLoading ? (
          <LoadingState label="Loading pipeline…" />
        ) : isError ? (
          <ErrorState message="Could not load leads." onRetry={() => { boardQ.refetch(); leadsQ.refetch(); }} />
        ) : total === 0 ? (
          <EmptyState
            icon={Users}
            title="No leads yet"
            description="Leads are captured automatically from WhatsApp, portals, and Meta ads. New enquiries will appear here in seconds."
          />
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {LEAD_STAGES.map((stage) => (
              <div key={stage} className="flex w-72 flex-shrink-0 flex-col rounded-xl bg-muted/40 p-3">
                <div className="mb-3 flex items-center justify-between px-1">
                  <span className="text-sm font-semibold">{STAGE_LABELS[stage]}</span>
                  <Badge tone="neutral">{counts[stage] ?? byStage[stage].length}</Badge>
                </div>
                <div className="flex flex-col gap-2">
                  {byStage[stage].length === 0 ? (
                    <p className="px-1 py-6 text-center text-xs text-muted-foreground">No leads</p>
                  ) : (
                    byStage[stage].map((lead) => <LeadCard key={lead.id} lead={lead} />)
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
