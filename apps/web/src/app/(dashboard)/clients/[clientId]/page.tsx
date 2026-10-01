'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  CalendarClock,
  CreditCard,
  Mail,
  MessageSquare,
  Phone,
  ShoppingCart,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { useClient, useClientTimeline } from '@/hooks/use-queries';
import { formatDateIST, formatDateTimeIST, paiseToRupees } from '@/lib/format';
import type { TimelineEvent } from '@/lib/types';

const TIMELINE_ICON: Record<string, typeof MessageSquare> = {
  CONVERSATION: MessageSquare,
  ORDER: ShoppingCart,
  BOOKING: CalendarClock,
  PAYMENT: CreditCard,
};

function timelineSummary(event: TimelineEvent): string {
  const parts = [event.title];
  if (event.status) parts.push(event.status.toLowerCase());
  if (event.amountPaise) parts.push(paiseToRupees(event.amountPaise));
  return parts.join(' · ');
}

export default function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const clientQ = useClient(clientId);
  const timelineQ = useClientTimeline(clientId);

  if (clientQ.isLoading) return <LoadingState label="Loading client…" className="min-h-[60vh]" />;
  if (clientQ.isError || !clientQ.data)
    return <ErrorState error={clientQ.error} onRetry={() => clientQ.refetch()} className="min-h-[60vh]" />;

  const client = clientQ.data;

  return (
    <div>
      <div className="border-b border-border bg-card px-4 py-3 lg:px-6">
        <Link href="/clients" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to clients
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-3 lg:p-6">
        {/* Left: profile + metrics */}
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center">
                <Avatar name={client.name ?? 'Unknown'} src={client.avatarUrl ?? undefined} size="lg" className="h-16 w-16 text-lg" />
                <h2 className="mt-3 text-lg font-bold">{client.name ?? 'Unknown'}</h2>
              </div>
              <dl className="mt-5 space-y-2.5 text-sm">
                {client.phone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="h-4 w-4" /> <span className="text-foreground">{client.phone}</span>
                  </div>
                )}
                {client.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="h-4 w-4" /> <span className="text-foreground">{client.email}</span>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-3">
            <MetricTile
              icon={Wallet}
              label="Lifetime value"
              value={client.ltvScore != null ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(client.ltvScore) : '—'}
              tone="text-emerald-400 bg-emerald-500/15"
            />
            <MetricTile
              icon={ShoppingCart}
              label="Total orders"
              value={String(client.totalOrders ?? 0)}
              tone="text-sky-400 bg-sky-500/15"
            />
            <MetricTile
              icon={Wallet}
              label="Total spent"
              value={paiseToRupees(client.totalSpentPaise)}
              tone="text-violet-400 bg-violet-500/15"
            />
            <MetricTile
              icon={TrendingDown}
              label="Churn risk"
              value={client.churnRisk != null ? `${(client.churnRisk * 100).toFixed(0)}%` : '—'}
              tone="text-amber-400 bg-amber-500/15"
              badge={client.churnRisk != null ? (client.churnRisk > 0.6 ? 'HIGH' : client.churnRisk > 0.3 ? 'MEDIUM' : 'LOW') : undefined}
            />
          </div>
        </div>

        {/* Right: timeline */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Activity timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {timelineQ.isLoading ? (
                <LoadingState className="py-8" />
              ) : !timelineQ.data || (timelineQ.data.events ?? []).length === 0 ? (
                <EmptyState icon={MessageSquare} title="No activity yet" className="py-10" />
              ) : (
                <ol className="relative space-y-5 border-l border-border pl-6">
                  {(timelineQ.data.events ?? []).map((event, idx) => {
                    const Icon = TIMELINE_ICON[event.type] ?? MessageSquare;
                    return (
                      <li key={idx} className="relative">
                        <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                        </span>
                        <p className="text-sm">{timelineSummary(event)}</p>
                        <p className="text-xs text-muted-foreground">{formatDateTimeIST(event.timestamp)}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  tone,
  badge,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  tone: string;
  badge?: string;
}) {
  return (
    <Card className="p-4">
      <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {badge && <StatusBadge value={badge} className="mt-1" />}
    </Card>
  );
}
