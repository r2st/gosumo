'use client';

import Link from 'next/link';
import { CalendarCheck, Clock, IndianRupee, MessagesSquare, Target } from 'lucide-react';
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
import { Avatar } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/status-badge';
import { ChannelIcon } from '@/components/channel-icon';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { MorningBriefing } from '@/components/dashboard/morning-briefing';
import { BriefingMetrics } from '@/components/dashboard/briefing-metrics';
import { NorthStarKpi } from '@/components/dashboard/north-star-kpi';
import {
  useBookings,
  useConversationReport,
  useConversations,
  useDashboardMetrics,
  useRevenueReport,
} from '@/hooks/use-queries';
import { formatDuration, formatRatioPct, paiseToCompactRupees, timeAgo } from '@/lib/format';

export default function DashboardPage() {
  const metricsQ = useDashboardMetrics();
  const convReportQ = useConversationReport({ granularity: 'DAY' });
  const revReportQ = useRevenueReport({ granularity: 'DAY' });
  const bookingsQ = useBookings({ status: 'CONFIRMED', limit: 1 });
  const recentQ = useConversations({ limit: 6, include: 'client' });

  const m = metricsQ.data;
  const conv = m?.conversations;
  const resolutionRate = conv && conv.total > 0 ? conv.resolved / conv.total : 0;

  return (
    <div>
      <PageHeader title="Dashboard" description="Today at a glance across all your channels." />

      <div className="space-y-6 p-4 lg:p-6">
        {/* GoSumo Realty — morning briefing: four glance metrics + the 7:30 AM digest */}
        <BriefingMetrics />
        <MorningBriefing />

        {metricsQ.isError ? (
          <ErrorState
            error={metricsQ.error}
            onRetry={() => metricsQ.refetch()}
          />
        ) : (
          <>
            {/* GoSumo Realty — North Star: site visits per 100 leads (goal ≥ 8) */}
            <NorthStarKpi />

            {/* KPI cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <KpiCard
                label="Conversations"
                value={String(conv?.total ?? 0)}
                hint={`${conv?.open ?? 0} open · ${conv?.escalated ?? 0} escalated`}
                icon={MessagesSquare}
                iconClassName="bg-accent text-accent-foreground"
                loading={metricsQ.isLoading}
              />
              <KpiCard
                label="Avg response time"
                value={formatDuration(conv?.avgFirstResponseTimeMs)}
                hint="First response"
                icon={Clock}
                iconClassName="bg-sky-50 text-sky-600"
                loading={metricsQ.isLoading}
              />
              <KpiCard
                label="Resolution rate"
                value={formatRatioPct(resolutionRate)}
                hint={`${conv?.resolved ?? 0} resolved`}
                icon={Target}
                iconClassName="bg-emerald-50 text-emerald-600"
                loading={metricsQ.isLoading}
              />
              <KpiCard
                label="Revenue"
                value={paiseToCompactRupees(m?.revenue.total)}
                hint={`${m?.revenue.orders ?? 0} orders`}
                icon={IndianRupee}
                iconClassName="bg-amber-50 text-amber-600"
                loading={metricsQ.isLoading}
              />
              <KpiCard
                label="Active bookings"
                value={String(bookingsQ.data?.pagination.total ?? 0)}
                hint="Confirmed upcoming"
                icon={CalendarCheck}
                iconClassName="bg-violet-50 text-violet-600"
                loading={bookingsQ.isLoading}
              />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ChartCard
                  title="Conversation volume (7 days)"
                  loading={convReportQ.isLoading}
                  empty={!convReportQ.data?.timeSeries?.length}
                >
                  {convReportQ.data && <ConversationVolumeChart data={convReportQ.data.timeSeries} />}
                </ChartCard>
              </div>
              <ChartCard
                title="AI vs human resolution"
                loading={metricsQ.isLoading}
                empty={!m || m.messages.aiSent + m.messages.humanSent === 0}
              >
                {m && <ResolutionPieChart aiSent={m.messages.aiSent} humanSent={m.messages.humanSent} />}
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ChartCard
                  title="Revenue trend"
                  loading={revReportQ.isLoading}
                  empty={!revReportQ.data?.timeSeries?.length}
                >
                  {revReportQ.data && <RevenueTrendChart data={revReportQ.data.timeSeries} />}
                </ChartCard>
              </div>
              <ChartCard
                title="Conversations by channel"
                loading={metricsQ.isLoading}
                empty={!m?.channels?.length}
              >
                {m && (
                  <ChannelBarChart
                    data={m.channels.map((c) => ({ channel: c.channelType.replace('_', ' '), count: c.conversationCount }))}
                  />
                )}
              </ChartCard>
            </div>

            {/* Recent activity */}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Recent activity</CardTitle>
                <Link href="/conversations" className="text-xs font-medium text-primary hover:underline">
                  View all
                </Link>
              </CardHeader>
              <CardContent>
                {recentQ.data && recentQ.data.data.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {recentQ.data.data.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/conversations?id=${c.id}`}
                          className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 hover:bg-muted"
                        >
                          <Avatar name={c.client?.name ?? 'Unknown'} src={c.client?.avatarUrl} size="md" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{c.client?.name ?? 'Unknown client'}</p>
                              <ChannelIcon channel={c.channelType} />
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {c.lastMessagePreview ?? 'No messages yet'}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <StatusBadge value={c.status} />
                            <span className="text-xs text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    icon={MessagesSquare}
                    title="No recent conversations"
                    description="New customer conversations will show up here."
                    className="py-10"
                  />
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
