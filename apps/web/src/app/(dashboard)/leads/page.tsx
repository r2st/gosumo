'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Flame, Search, Sparkles, UserPlus, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { LeadCard } from '@/components/leads/lead-card';
import { LeadDossier } from '@/components/leads/lead-dossier';
import { useLeads, useLeadBoard } from '@/hooks/use-realty';
import { useTeam } from '@/hooks/use-settings';
import { usePullToRefresh, PullToRefreshIndicator } from '@/hooks/use-pull-to-refresh';
import { leadsToCsv, downloadCsv } from '@/lib/csv-export';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import {
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  hasActiveLeadFilters,
  PIPELINE_COLUMNS,
  SOURCE_FILTERS,
  type LeadFilterState,
} from '@/lib/realty-ui';
import { formatDateIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Lead, LeadStage, LeadTemperature } from '@/lib/realty-types';

const TEMPERATURE_FILTERS: { key: 'ALL' | LeadTemperature; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'HOT', label: 'Hot' },
  { key: 'WARM', label: 'Warm' },
  { key: 'COLD', label: 'Cold' },
  { key: 'JUNK', label: 'Junk' },
];

function LeadsBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const boardQ = useLeadBoard();
  // Pull a generous page of leads and group them into columns client-side.
  const leadsQ = useLeads({ limit: 100 });
  const teamQ = useTeam();

  // Pull-to-refresh (touch only) refreshes both the board totals and the lead page.
  const { containerRef, pullDistance, isRefreshing } = usePullToRefresh<HTMLDivElement>(async () => {
    await Promise.all([boardQ.refetch(), leadsQ.refetch()]);
  });

  const stageCounts = useMemo(() => {
    const map: Partial<Record<LeadStage, number>> = {};
    for (const col of boardQ.data ?? []) map[col.stage] = col.count;
    return map;
  }, [boardQ.data]);

  const leads = useMemo(() => leadsQ.data?.data ?? [], [leadsQ.data]);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState<LeadFilterState>(DEFAULT_LEAD_FILTERS);
  const filtered = useMemo(() => filterLeads(leads, filters), [leads, filters]);
  const filtersActive = hasActiveLeadFilters(filters);

  // Agent options: the assigned agents actually present on the loaded leads,
  // labelled from the team roster where we can resolve a name.
  const agentOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of teamQ.data?.data ?? []) names.set(m.id, m.name);
    const ids = new Set<string>();
    let hasUnassigned = false;
    for (const l of leads) {
      if (l.assignedAgentId) ids.add(l.assignedAgentId);
      else hasUnassigned = true;
    }
    const opts = [{ label: 'All agents', value: 'ALL' }];
    for (const id of ids) opts.push({ label: names.get(id) ?? `Agent ${id.slice(0, 6)}`, value: id });
    if (hasUnassigned) opts.push({ label: 'Unassigned', value: 'UNASSIGNED' });
    return opts;
  }, [leads, teamQ.data]);

  const byColumn = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const col of PIPELINE_COLUMNS) map[col.key] = [];
    for (const lead of filtered) {
      const col = PIPELINE_COLUMNS.find((c) => c.stages.includes(lead.stage));
      if (col) map[col.key].push(lead);
    }
    return map;
  }, [filtered]);

  // Per-column counts. With no filters we trust the server board totals (which
  // count beyond the 100-lead page); once filtering, we show the visible count.
  const columnCount = (colKey: string, stages: LeadStage[]) => {
    if (filtersActive) return byColumn[colKey].length;
    const serverTotal = stages.reduce((sum, s) => sum + (stageCounts[s] ?? 0), 0);
    return serverTotal || byColumn[colKey].length;
  };

  // Top-bar stats: today's new leads (created today, IST) and qualified count.
  const today = formatDateIST(new Date().toISOString());
  const newToday = leads.filter((l) => formatDateIST(l.createdAt) === today).length;
  const qualifiedCount = stageCounts.QUALIFIED ?? byColumn.QUALIFIED?.length ?? 0;
  const hotCount = leads.filter((l) => l.temperature === 'HOT').length;

  // Mobile: one pipeline stage visible at a time via a tab bar.
  const [activeTab, setActiveTab] = useState<string>(PIPELINE_COLUMNS[0].key);

  // Deep-link support: /leads?lead=<id> opens the dossier (from the morning briefing).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const paramLead = params?.get('lead') ?? null;
  useEffect(() => {
    if (paramLead) setSelectedId(paramLead);
  }, [paramLead]);

  const selected = leads.find((l) => l.id === selectedId) ?? null;

  const closeDossier = () => {
    setSelectedId(null);
    if (paramLead) router.replace('/leads');
  };

  const isLoading = boardQ.isLoading || leadsQ.isLoading;
  const isError = boardQ.isError || leadsQ.isError;

  const activeColumn = PIPELINE_COLUMNS.find((c) => c.key === activeTab) ?? PIPELINE_COLUMNS[0];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Lead pipeline"
        description="Your AI-managed pipeline — every buyer captured, qualified, and followed up."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={filtered.length === 0}
            onClick={() => downloadCsv(`leads-${today}.csv`, leadsToCsv(filtered))}
          >
            <Download className="h-4 w-4" /> Export
          </Button>
        }
      />

      {/* Today's stats */}
      <div className="flex flex-wrap gap-3 px-4 pt-4 lg:px-6">
        <StatChip icon={UserPlus} label="New today" value={newToday} tone="text-indigo-600" />
        <StatChip icon={Sparkles} label="Qualified" value={qualifiedCount} tone="text-emerald-600" />
        <StatChip icon={Flame} label="Hot leads" value={hotCount} tone="text-rose-600" />
      </div>

      {/* Filter bar */}
      {!isError && leads.length > 0 && (
        <div className="flex flex-col gap-3 px-4 pt-4 lg:px-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search name or phone…"
                aria-label="Search leads"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                className="pl-9"
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Select
                aria-label="Filter by source"
                value={filters.sourceKey}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, sourceKey: e.target.value as LeadFilterState['sourceKey'] }))
                }
                options={SOURCE_FILTERS.map((s) => ({ label: s.label, value: s.key }))}
                className="sm:w-40"
              />
              <Select
                aria-label="Filter by agent"
                value={filters.agentId}
                onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value }))}
                options={agentOptions}
                className="sm:w-44"
              />
            </div>
          </div>

          {/* Temperature pills */}
          <div className="flex flex-wrap gap-1.5">
            {TEMPERATURE_FILTERS.map((t) => {
              const active = filters.temperature === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilters((f) => ({ ...f, temperature: t.key }))}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    active
                      ? 'border-accent bg-accent text-accent-foreground'
                      : 'border-border bg-card text-muted-foreground hover:border-accent hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div ref={containerRef} className="relative flex-1 overflow-auto p-4 lg:p-6">
        <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
        {isLoading ? (
          <LoadingState label="Loading pipeline…" />
        ) : isError ? (
          <ErrorState
            error={boardQ.error ?? leadsQ.error}
            message="Could not load leads."
            onRetry={() => {
              boardQ.refetch();
              leadsQ.refetch();
            }}
          />
        ) : leads.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No leads yet"
            description="Leads are captured automatically from WhatsApp, portals, and Meta ads. New enquiries will appear here in seconds."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matching leads"
            description="No leads match your current filters. Try clearing the search or widening the filters."
          />
        ) : (
          <>
            {/* Desktop / tablet: horizontal kanban */}
            <div className="hidden gap-4 overflow-x-auto pb-4 md:flex">
              {PIPELINE_COLUMNS.map((col) => {
                const columnLeads = byColumn[col.key];
                return (
                  <div
                    key={col.key}
                    className="flex w-72 flex-shrink-0 flex-col rounded-xl bg-muted/40 p-3"
                  >
                    <div className="mb-3 flex items-center justify-between px-1">
                      <span className="text-sm font-semibold">{col.label}</span>
                      <Badge tone="neutral">{columnCount(col.key, col.stages)}</Badge>
                    </div>
                    <div className="flex flex-col gap-2">
                      {columnLeads.length === 0 ? (
                        <p className="px-1 py-6 text-center text-xs text-muted-foreground">No leads</p>
                      ) : (
                        columnLeads.map((lead) => (
                          <LeadCard key={lead.id} lead={lead} href={`/leads/${lead.id}`} />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Mobile: stage tab bar + a single stacked list (no horizontal scroll) */}
            <div className="md:hidden">
              <div
                role="tablist"
                aria-label="Pipeline stages"
                className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-3"
              >
                {PIPELINE_COLUMNS.map((col) => {
                  const active = col.key === activeTab;
                  return (
                    <button
                      key={col.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveTab(col.key)}
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                        active
                          ? 'border-accent bg-accent text-accent-foreground'
                          : 'border-border bg-card text-muted-foreground',
                      )}
                    >
                      {col.label}
                      <span
                        className={cn(
                          'rounded-full px-1.5 text-[11px]',
                          active ? 'bg-accent-foreground/15' : 'bg-muted',
                        )}
                      >
                        {columnCount(col.key, col.stages)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div role="tabpanel" className="flex flex-col gap-2">
                {byColumn[activeColumn.key].length === 0 ? (
                  <p className="px-1 py-10 text-center text-sm text-muted-foreground">
                    No leads in {activeColumn.label}.
                  </p>
                ) : (
                  byColumn[activeColumn.key].map((lead) => (
                    <LeadCard key={lead.id} lead={lead} href={`/leads/${lead.id}`} />
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <LeadDossier lead={selected} onClose={closeDossier} />
    </div>
  );
}

function StatChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof UserPlus;
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2 shadow-sm">
      <Icon className={`h-4 w-4 ${tone}`} />
      <span className={`text-lg font-bold tracking-tight ${tone}`}>{value}</span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

export default function LeadsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading pipeline…" />}>
      <LeadsBoard />
    </Suspense>
  );
}
