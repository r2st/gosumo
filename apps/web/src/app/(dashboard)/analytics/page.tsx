'use client';

import { useState } from 'react';
import { Check, Download } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
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
import { useExportReport, type ExportReportRequest } from '@/hooks/use-analytics';

type TabKey = 'overview' | 'conversations' | 'revenue' | 'clients' | 'ai' | 'team';

const TABS: TabItem[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'clients', label: 'Clients' },
  { key: 'ai', label: 'AI Performance' },
  { key: 'team', label: 'Team' },
];

const EXPORT_TYPE: Record<TabKey, ExportReportRequest['reportType']> = {
  overview: 'CONVERSATIONS',
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
  const [queued, setQueued] = useState(false);

  const handleExport = (format: 'CSV' | 'PDF') => {
    exportReport.mutate(
      { reportType: EXPORT_TYPE[tab], format, from: range.from, to: range.to },
      {
        onSuccess: () => {
          setQueued(true);
          setTimeout(() => setQueued(false), 2500);
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Conversations, revenue, clients, AI performance and team productivity."
        actions={
          <>
            <Button variant="outline" size="sm" loading={exportReport.isPending} onClick={() => handleExport('CSV')}>
              {queued ? <Check className="h-4 w-4 text-success" /> : <Download className="h-4 w-4" />}
              {queued ? 'Queued' : 'Export CSV'}
            </Button>
            <Button variant="outline" size="sm" disabled={exportReport.isPending} onClick={() => handleExport('PDF')}>
              <Download className="h-4 w-4" /> PDF
            </Button>
          </>
        }
      />

      <div className="space-y-5 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedTabs items={TABS} activeKey={tab} onChange={(k) => setTab(k as TabKey)} />
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {tab === 'overview' && <OverviewSection range={range} />}
        {tab === 'conversations' && <ConversationsSection range={range} />}
        {tab === 'revenue' && <RevenueSection range={range} />}
        {tab === 'clients' && <ClientsSection range={range} />}
        {tab === 'ai' && <AiSection range={range} />}
        {tab === 'team' && <TeamSection range={range} />}
      </div>
    </div>
  );
}
