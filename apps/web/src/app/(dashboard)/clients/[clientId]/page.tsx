'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  CalendarClock,
  CreditCard,
  Heart,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  ShoppingCart,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { useClient, useClientTimeline } from '@/hooks/use-queries';
import { formatDateIST, formatDateTimeIST, paiseToRupees } from '@/lib/format';
import type { ClientTimelineItem } from '@/lib/types';

const TIMELINE_ICON = {
  MESSAGE: MessageSquare,
  ORDER: ShoppingCart,
  BOOKING: CalendarClock,
  PAYMENT: CreditCard,
  CAMPAIGN: Mail,
} as const;

function timelineSummary(item: ClientTimelineItem): string {
  switch (item.type) {
    case 'MESSAGE':
      return `${item.data.direction === 'INBOUND' ? 'Received' : 'Sent'}: ${item.data.preview}`;
    case 'ORDER':
      return `Order ${item.data.status} · ${paiseToRupees(item.data.amount)}`;
    case 'BOOKING':
      return `Booking ${item.data.status} · ${item.data.serviceName}`;
    case 'PAYMENT':
      return `Payment ${item.data.status} · ${paiseToRupees(item.data.amount)}`;
    case 'CAMPAIGN':
      return `Campaign "${item.data.campaignName}" ${item.data.event}`;
    default:
      return '';
  }
}

export default function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const clientQ = useClient(clientId, ['intelligence', 'orders', 'conversations']);
  const timelineQ = useClientTimeline(clientId);

  if (clientQ.isLoading) return <LoadingState label="Loading client…" className="min-h-[60vh]" />;
  if (clientQ.isError || !clientQ.data)
    return <ErrorState message={(clientQ.error as Error)?.message} onRetry={() => clientQ.refetch()} className="min-h-[60vh]" />;

  const client = clientQ.data;
  const intel = client.intelligence;
  const orders = client.orders ?? [];

  return (
    <div>
      <div className="border-b border-border bg-card px-4 py-3 lg:px-6">
        <Link href="/clients" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to clients
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-3 lg:p-6">
        {/* Left: profile + intelligence */}
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center">
                <Avatar name={client.name} src={client.avatarUrl} size="lg" className="h-16 w-16 text-lg" />
                <h2 className="mt-3 text-lg font-bold">{client.name}</h2>
                <Badge tone="neutral" className="mt-1">{client.source}</Badge>
                {client.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {client.tags.map((t) => (
                      <Badge key={t} tone="primary">{t}</Badge>
                    ))}
                  </div>
                )}
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
                {client.address?.city && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4" />{' '}
                    <span className="text-foreground">
                      {[client.address.city, client.address.state].filter(Boolean).join(', ')}
                    </span>
                  </div>
                )}
              </dl>
              {client.notes && (
                <p className="mt-4 rounded-md bg-muted p-3 text-sm text-muted-foreground">{client.notes}</p>
              )}
            </CardContent>
          </Card>

          {/* Intelligence metrics */}
          <div className="grid grid-cols-2 gap-3">
            <MetricTile
              icon={Wallet}
              label="Lifetime value"
              value={intel ? paiseToRupees(intel.ltv) : '—'}
              tone="text-emerald-600 bg-emerald-50"
            />
            <MetricTile
              icon={ShoppingCart}
              label="Total orders"
              value={String(intel?.totalOrders ?? 0)}
              tone="text-sky-600 bg-sky-50"
            />
            <MetricTile
              icon={Heart}
              label="Sentiment"
              value={intel ? intel.sentimentLabel.replace('_', ' ').toLowerCase() : '—'}
              tone="text-rose-600 bg-rose-50"
              capitalize
            />
            <MetricTile
              icon={TrendingDown}
              label="Churn risk"
              value={intel ? `${intel.churnRiskScore}%` : '—'}
              tone="text-amber-600 bg-amber-50"
              badge={intel?.churnRiskLevel}
            />
          </div>

          {intel?.interests && intel.interests.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Interests</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {intel.interests.map((i) => (
                    <Badge key={i} tone="info">{i}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: order history + timeline */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Order history</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {orders.length === 0 ? (
                <EmptyState icon={ShoppingCart} title="No orders yet" className="py-10" />
              ) : (
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Order</TH>
                      <TH>Status</TH>
                      <TH>Total</TH>
                      <TH>Date</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {orders.map((o) => (
                      <TR key={o.id}>
                        <TD className="font-medium">{o.orderNumber}</TD>
                        <TD>
                          <StatusBadge value={o.status} />
                        </TD>
                        <TD className="font-medium">{paiseToRupees(o.total)}</TD>
                        <TD className="text-muted-foreground">{formatDateIST(o.createdAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {timelineQ.isLoading ? (
                <LoadingState className="py-8" />
              ) : !timelineQ.data || timelineQ.data.items.length === 0 ? (
                <EmptyState icon={MessageSquare} title="No activity yet" className="py-10" />
              ) : (
                <ol className="relative space-y-5 border-l border-border pl-6">
                  {timelineQ.data.items.map((item, idx) => {
                    const Icon = TIMELINE_ICON[item.type] ?? MessageSquare;
                    return (
                      <li key={idx} className="relative">
                        <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                        </span>
                        <p className="text-sm">{timelineSummary(item)}</p>
                        <p className="text-xs text-muted-foreground">{formatDateTimeIST(item.timestamp)}</p>
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
  capitalize,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  tone: string;
  badge?: string;
  capitalize?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold ${capitalize ? 'capitalize' : ''}`}>{value}</p>
      {badge && <StatusBadge value={badge} className="mt-1" />}
    </Card>
  );
}
