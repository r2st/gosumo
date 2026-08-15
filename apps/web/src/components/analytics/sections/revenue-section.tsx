'use client';

import { IndianRupee, TrendingUp } from 'lucide-react';
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useRevenueReportFull } from '@/hooks/use-analytics';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { axisProps, shortDate, tooltipStyle } from '@/components/analytics/chart-kit';
import { formatDateIST, formatNumber, humanizeEnum, paiseToCompactRupees, paiseToRupees } from '@/lib/format';

export function RevenueSection({ range }: { range: DateRange }) {
  const { data, isLoading, isError, error, refetch } = useRevenueReportFull(range);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return <EmptyState icon={TrendingUp} title="No revenue data" />;

  const fulfillment = Object.entries(data.fulfillmentBreakdown ?? {});

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total revenue" value={paiseToCompactRupees(data.summary.totalRevenue)} icon={IndianRupee} />
        <KpiCard
          label="Net revenue"
          value={paiseToCompactRupees(data.summary.netRevenue)}
          icon={IndianRupee}
          hint={`${paiseToRupees(data.summary.totalRefunds)} refunded`}
        />
        <KpiCard label="Orders" value={formatNumber(data.summary.totalOrders)} icon={TrendingUp} />
        <KpiCard label="Avg order value" value={paiseToRupees(data.summary.avgOrderValue)} icon={IndianRupee} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue trend</CardTitle>
        </CardHeader>
        <CardContent>
          {data.timeSeries.length === 0 ? (
            <EmptyState title="No revenue in this period" className="py-12" />
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.timeSeries} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revFill2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} />
                  <YAxis yAxisId="left" {...axisProps} width={56} tickFormatter={(v) => paiseToCompactRupees(Number(v))} />
                  <YAxis yAxisId="right" orientation="right" {...axisProps} allowDecimals={false} width={32} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(l) => formatDateIST(String(l))}
                    formatter={(value: number, name: string) =>
                      name === 'Orders' ? [formatNumber(value), name] : [paiseToCompactRupees(value), name]
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area yAxisId="left" type="monotone" dataKey="revenue" name="Revenue" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#revFill2)" />
                  <Line yAxisId="right" type="monotone" dataKey="orders" name="Orders" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Top products</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!data.topProducts?.length ? (
              <EmptyState icon={TrendingUp} title="No sales data yet" className="py-10" />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Product</TH>
                    <TH className="text-right">Units</TH>
                    <TH className="text-right">Revenue</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.topProducts.slice(0, 10).map((p) => (
                    <TR key={p.itemId}>
                      <TD className="font-medium">{p.name}</TD>
                      <TD className="text-right">{formatNumber(p.quantity)}</TD>
                      <TD className="text-right font-medium">{paiseToRupees(p.revenue)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Fulfillment mix</CardTitle>
          </CardHeader>
          <CardContent>
            {fulfillment.length === 0 ? (
              <EmptyState title="No fulfillment data" className="py-10" />
            ) : (
              <ul className="space-y-4">
                {fulfillment.map(([type, v]) => (
                  <li key={type} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">{humanizeEnum(type)}</p>
                      <p className="text-xs text-muted-foreground">{formatNumber(v.orders)} orders</p>
                    </div>
                    <p className="text-sm font-semibold">{paiseToRupees(v.revenue)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
