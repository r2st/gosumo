'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateIST, paiseToCompactRupees } from '@/lib/format';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };

export function ChartCard({
  title,
  children,
  loading,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  loading?: boolean;
  empty?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : empty ? (
          <EmptyState title="No data yet" description="Data will appear here once activity starts." className="py-12" />
        ) : (
          <div className="h-[240px] w-full">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

function shortDate(value: string): string {
  // value is a YYYY-MM-DD or ISO date string from the analytics time series.
  try {
    return formatDateIST(value).replace(/ \d{4}$/, '');
  } catch {
    return value;
  }
}

export function ConversationVolumeChart({
  data,
}: {
  data: Array<{ date: string; created: number; resolved: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(l) => formatDateIST(String(l))}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="created" name="Created" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="resolved" name="Resolved" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function RevenueTrendChart({
  data,
}: {
  data: Array<{ date: string; revenue: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => paiseToCompactRupees(Number(v))}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(l) => formatDateIST(String(l))}
          formatter={(v: number) => [paiseToCompactRupees(v), 'Revenue']}
        />
        <Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#revFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const PIE_COLORS = ['hsl(var(--primary))', 'hsl(var(--success))', 'hsl(var(--warning))'];

export function ResolutionPieChart({ aiSent, humanSent }: { aiSent: number; humanSent: number }) {
  const data = [
    { name: 'AI handled', value: aiSent },
    { name: 'Human handled', value: humanSent },
  ];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={56} outerRadius={88} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function ChannelBarChart({
  data,
}: {
  data: Array<{ channel: string; count: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <XAxis dataKey="channel" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
        <Bar dataKey="count" name="Conversations" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const tooltipStyle = {
  borderRadius: 8,
  border: '1px solid hsl(var(--border))',
  fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
};
