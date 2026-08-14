'use client';

import { useState } from 'react';
import { Check, Download } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { Button } from '@/components/ui/button';
import { SegmentedTabs, type TabItem } from '@/components/ui/tabs';
import {
  DateRangePicker,
  defaultRange,
  type DateRange,
} from '@/components/analytics/date-range-picker';
import { OverviewSection } from '@/components/analytics/sections/overview-section';
import { ConversationsSection } from '@/components/analytics/sections/conversations-section';
import { RevenueSection } from '@/components/analytics/sections/revenue-section';
import { ClientsSection } from '@/components/analytics/sections/clients-section';
import { AiSection } from '@/components/analytics/sections/ai-section';
import { TeamSection } from '@/components/analytics/sections/team-section';
import { FunnelSection } from '@/components/analytics/sections/funnel-section';
import { SourceRoiSection } from '@/components/analytics/sections/source-roi-section';
import { useExportReport, type ExportReportRequest } from '@/hooks/use-analytics';
import { useDashboardMetrics } from '@/hooks/use-queries';
import { toCsv, downloadCsv } from '@/lib/csv-export';
import { formatDuration, formatNumber, formatRatioPct, paiseToRupees } from '@/lib/format';
import { channelLabel } from '@/components/channel-icon';

type TabKey = 'overview' | 'leads' | 'conversations' | 'revenue' | 'clients' | 'ai' | 'team';

const TABS: TabItem[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'leads', label: 'Leads' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'clients', label: 'Clients' },
  { key: 'ai', label: 'AI Performance' },
  { key: 'team', label: 'Team' },
];

const EXPORT_TYPE: Record<TabKey, ExportReportRequest['reportType']> = {
  overview: 'CONVERSATIONS',
  leads: 'CLIENTS',
  conversations: 'CONVERSATIONS',
  revenue: 'REVENUE',
  clients: 'CLIENTS',
  ai: 'AI_AUTONOMY',
  team: 'CONVERSATIONS',
};

export default function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>(() => defaultRange());
  const [tab, setTab] = useState<TabKey>('overview');
  const exportReport = useExportReport();
  // POST /analytics/reports/export queues a server-side render — an
  // undecorated write. The CSV button builds its file in the browser from
  // data already on screen, so it stays available to every role.
  const { canWrite } = usePermissions();
  const [queued, setQueued] = useState(false);

  // Headline metrics for the client-side CSV export (the summary shown on Overview).
  const { data: metrics } = useDashboardMetrics({ from: range.from, to: range.to });

  // Queue a server-rendered PDF report for the current tab.
  const handleExportPdf = () => {
    exportReport.mutate(
      { reportType: EXPORT_TYPE[tab], format: 'PDF', from: range.from, to: range.to },
      {
        onSuccess: () => {
          setQueued(true);
          setTimeout(() => setQueued(false), 2500);
        },
      },
    );
  };

  // Instant client-side CSV of the currently displayed summary metrics.
  const handleExportCsv = () => {
    if (!metrics) return;
    const rows: { metric: string; value: string }[] = [
      { metric: 'Period from', value: metrics.period.from },
      { metric: 'Period to', value: metrics.period.to },
      { metric: 'Conversations — total', value: formatNumber(metrics.conversations.total) },
      { metric: 'Conversations — open', value: formatNumber(metrics.conversations.open) },
      { metric: 'Conversations — resolved', value: formatNumber(metrics.conversations.resolved) },
      { metric: 'Conversations — escalated', value: formatNumber(metrics.conversations.escalated) },
      {
        metric: 'Avg first response',
        value: formatDuration(metrics.conversations.avgFirstResponseTimeMs),
      },
      {
        metric: 'Avg resolution',
        value: formatDuration(metrics.conversations.avgResolutionTimeMs),
      },
      { metric: 'Net revenue', value: paiseToRupees(metrics.revenue.total) },
      { metric: 'Orders', value: formatNumber(metrics.revenue.orders) },
      { metric: 'Avg order value', value: paiseToRupees(metrics.revenue.avgOrderValue) },
      { metric: 'AI autonomy rate', value: formatRatioPct(metrics.ai.autonomyRate) },
      { metric: 'AI avg confidence', value: formatRatioPct(metrics.ai.avgConfidence) },
      { metric: 'AI approval rate', value: formatRatioPct(metrics.ai.approvalRate) },
      { metric: 'Clients — total', value: formatNumber(metrics.clients.total) },
      { metric: 'Clients — new this period', value: formatNumber(metrics.clients.newThisPeriod) },
      { metric: 'Clients — churn risk', value: formatNumber(metrics.clients.churnRisk) },
      ...metrics.channels.map((c) => ({
        metric: `Channel — ${channelLabel(c.channelType)} conversations`,
        value: formatNumber(c.conversationCount),
      })),
    ];
    const csv = toCsv(rows, [
      { header: 'Metric', value: (r) => r.metric },
      { header: 'Value', value: (r) => r.value },
    ]);
    downloadCsv(`analytics-${range.from}-to-${range.to}.csv`, csv);
  };

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Conversations, revenue, clients, AI performance and team productivity."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={!metrics} onClick={handleExportCsv}>
              <Download className="h-4 w-4" /> Export
            </Button>
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                loading={exportReport.isPending}
                onClick={handleExportPdf}
              >
                {queued ? (
                  <Check className="h-4 w-4 text-success" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {queued ? 'Queued' : 'PDF'}
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-5 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedTabs items={TABS} activeKey={tab} onChange={(k) => setTab(k as TabKey)} />
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {tab === 'overview' && <OverviewSection range={range} />}
        {tab === 'leads' && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <FunnelSection />
            <SourceRoiSection range={range} />
          </div>
        )}
        {tab === 'conversations' && <ConversationsSection range={range} />}
        {tab === 'revenue' && <RevenueSection range={range} />}
        {tab === 'clients' && <ClientsSection range={range} />}
        {tab === 'ai' && <AiSection range={range} />}
        {tab === 'team' && <TeamSection range={range} />}
      </div>
    </div>
  );
}
