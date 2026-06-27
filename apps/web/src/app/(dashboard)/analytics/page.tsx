'use client';

import { Bot, IndianRupee, MessagesSquare, Percent, TrendingUp, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { KpiCard } from '@/components/dashboard/kpi-card';
import {
  ChannelBarChart,
  ChartCard,
  ConversationVolumeChart,
  ResolutionPieChart,
  RevenueTrendChart,
} from '@/components/dashboard/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/states';
import {
  useConversationReport,
  useDashboardMetrics,
  useRevenueReport,
} from '@/hooks/use-queries';
import { formatDuration, formatNumber, formatRatioPct, paiseToCompactRupees, paiseToRupees } from '@/lib/format';

export default function AnalyticsPage() {
  const metricsQ = useDashboardMetrics();
  const convQ = useConversationReport({ granularity: 'DAY' });
  const revQ = useRevenueReport({ granularity: 'DAY' });

  const m = metricsQ.data;

  return (
    <div>
      <PageHeader title="Analytics" description="Performance across conversations, AI autonomy and revenue." />

      <div className="space-y-6 p-4 lg:p-6">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Total conversations"
            value={formatNumber(m?.conversations.total)}
            icon={MessagesSquare}
            loading={metricsQ.isLoading}
          />
          <KpiCard
            label="AI autonomy rate"
            value={formatRatioPct(m?.ai.autonomyRate)}
            icon={Bot}
            iconClassName="bg-violet-50 text-violet-600"
            hint={`avg confidence ${formatRatioPct(m?.ai.avgConfidence)}`}
            loading={metricsQ.isLoading}
          />
          <KpiCard
            label="Net revenue"
            value={paiseToCompactRupees(m?.revenue.total)}
            icon={IndianRupee}
            iconClassName="bg-amber-50 text-amber-600"
            hint={`AOV ${paiseToRupees(m?.revenue.avgOrderValue)}`}
            loading={metricsQ.isLoading}
          />
          <KpiCard
            label="Active clients"
            value={formatNumber(m?.clients.activeThisPeriod)}
            icon={Users}
            iconClassName="bg-emerald-50 text-emerald-600"
            hint={`${m?.clients.newThisPeriod ?? 0} new`}
            loading={metricsQ.isLoading}
          />
        </div>

        {/* AI deep-dive row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Auto-executed" value={formatNumber(m?.ai.autoExecuted)} icon={Bot} loading={metricsQ.isLoading} />
          <KpiCard label="Reviewed (HITL)" value={formatNumber(m?.ai.reviewed)} icon={Percent} loading={metricsQ.isLoading} />
          <KpiCard label="Escalated" value={formatNumber(m?.ai.escalated)} icon={TrendingUp} loading={metricsQ.isLoading} />
          <KpiCard
            label="Avg resolution"
            value={formatDuration(m?.conversations.avgResolutionTimeMs)}
            icon={MessagesSquare}
            loading={metricsQ.isLoading}
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ChartCard title="Conversation volume" loading={convQ.isLoading} empty={!convQ.data?.timeSeries?.length}>
              {convQ.data && <ConversationVolumeChart data={convQ.data.timeSeries} />}
            </ChartCard>
          </div>
          <ChartCard
            title="AI vs human"
            loading={metricsQ.isLoading}
            empty={!m || m.messages.aiSent + m.messages.humanSent === 0}
          >
            {m && <ResolutionPieChart aiSent={m.messages.aiSent} humanSent={m.messages.humanSent} />}
          </ChartCard>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ChartCard title="Revenue trend" loading={revQ.isLoading} empty={!revQ.data?.timeSeries?.length}>
              {revQ.data && <RevenueTrendChart data={revQ.data.timeSeries} />}
            </ChartCard>
          </div>
          <ChartCard title="By channel" loading={metricsQ.isLoading} empty={!m?.channels?.length}>
            {m && (
              <ChannelBarChart
                data={m.channels.map((c) => ({ channel: c.channelType.replace('_', ' '), count: c.conversationCount }))}
              />
            )}
          </ChartCard>
        </div>

        {/* Top products */}
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!revQ.data?.topProducts?.length ? (
              <EmptyState icon={TrendingUp} title="No sales data yet" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Product</TH>
                    <TH>Units sold</TH>
                    <TH>Revenue</TH>
                  </TR>
                </THead>
                <TBody>
                  {revQ.data.topProducts.map((p) => (
                    <TR key={p.itemId}>
                      <TD className="font-medium">{p.name}</TD>
                      <TD>{formatNumber(p.quantity)}</TD>
                      <TD className="font-medium">{paiseToRupees(p.revenue)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
