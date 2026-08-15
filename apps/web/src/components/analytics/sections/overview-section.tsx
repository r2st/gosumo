'use client';

import { AlertTriangle, Bot, Clock, IndianRupee, MessagesSquare, Users } from 'lucide-react';
import {
  BarChart,
  Bar,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useDashboardMetrics } from '@/hooks/use-queries';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { CHANNEL_COLORS, LegendDot, axisProps, tooltipStyle } from '@/components/analytics/chart-kit';
import { channelLabel } from '@/components/channel-icon';
import {
  formatDuration,
  formatNumber,
  formatRatioPct,
  paiseToCompactRupees,
  paiseToRupees,
} from '@/lib/format';

export function OverviewSection({ range }: { range: DateRange }) {
  const { data: m, isLoading, isError, error, refetch } = useDashboardMetrics({ from: range.from, to: range.to });

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const resolution = m
    ? [
        { name: 'AI handled', value: m.messages.aiSent, color: 'hsl(var(--primary))' },
        { name: 'Human handled', value: m.messages.humanSent, color: '#0ea5e9' },
        { name: 'Escalated', value: m.conversations.escalated, color: 'hsl(var(--warning))' },
      ].filter((d) => d.value > 0)
    : [];

  const channelData = (m?.channels ?? []).map((c) => ({
    channel: channelLabel(c.channelType),
    type: c.channelType,
    conversations: c.conversationCount,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Conversations"
          value={formatNumber(m?.conversations.total)}
          icon={MessagesSquare}
          hint={`${formatNumber(m?.conversations.open)} open · ${formatNumber(m?.conversations.resolved)} resolved`}
          loading={isLoading}
        />
        <KpiCard
          label="Net revenue"
          value={paiseToCompactRupees(m?.revenue.total)}
          icon={IndianRupee}
          iconClassName="bg-amber-50 text-amber-600"
          hint={`${formatNumber(m?.revenue.orders)} orders · AOV ${paiseToRupees(m?.revenue.avgOrderValue)}`}
          loading={isLoading}
        />
        <KpiCard
          label="AI autonomy"
          value={formatRatioPct(m?.ai.autonomyRate)}
          icon={Bot}
          iconClassName="bg-violet-50 text-violet-600"
          hint={`avg confidence ${formatRatioPct(m?.ai.avgConfidence)}`}
          loading={isLoading}
        />
        <KpiCard
          label="Clients"
          value={formatNumber(m?.clients.total)}
          icon={Users}
          iconClassName="bg-emerald-50 text-emerald-600"
          hint={`${formatNumber(m?.clients.newThisPeriod)} new · ${formatNumber(m?.clients.churnRisk)} at risk`}
          loading={isLoading}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Avg first response" value={formatDuration(m?.conversations.avgFirstResponseTimeMs)} icon={Clock} loading={isLoading} />
        <KpiCard label="Avg resolution" value={formatDuration(m?.conversations.avgResolutionTimeMs)} icon={Clock} loading={isLoading} />
        <KpiCard label="AI approval rate" value={formatRatioPct(m?.ai.approvalRate)} icon={Bot} loading={isLoading} />
        <KpiCard label="Escalated" value={formatNumber(m?.conversations.escalated)} icon={AlertTriangle} loading={isLoading} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Channel activity</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={channelData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <XAxis dataKey="channel" {...axisProps} />
                    <YAxis {...axisProps} allowDecimals={false} width={32} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
                    <Bar dataKey="conversations" name="Conversations" radius={[4, 4, 0, 0]}>
                      {channelData.map((c) => (
                        <Cell key={c.type} fill={CHANNEL_COLORS[c.type] ?? 'hsl(var(--primary))'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>AI vs human resolution</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-44 w-full" />
            ) : resolution.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No resolution data yet.</p>
            ) : (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <div className="h-44 w-44 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={resolution} dataKey="value" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2}>
                        {resolution.map((d) => (
                          <Cell key={d.name} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-2">
                  {resolution.map((d) => (
                    <LegendDot key={d.name} color={d.color} label={d.name} value={formatNumber(d.value)} />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
