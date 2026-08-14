'use client';

import { useState } from 'react';
import { Search, ShoppingCart } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { OrderDetailDrawer } from '@/components/orders/order-detail-drawer';
import { useOrders } from '@/hooks/use-orders';
import { formatDateIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import type { FulfillmentType, OrderStatus } from '@/lib/types';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['DRAFT', 'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'READY_FOR_PICKUP', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'].map(
    (v) => ({ label: humanizeEnum(v), value: v }),
  ),
];

const FULFILLMENT_OPTIONS = [
  { label: 'All fulfilment', value: '' },
  ...['DELIVERY', 'PICKUP', 'DIGITAL', 'IN_STORE'].map((v) => ({ label: humanizeEnum(v), value: v })),
];

export default function OrdersPage() {
  const [status, setStatus] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useOrders({
    status: (status || undefined) as OrderStatus | undefined,
    fulfillmentType: (fulfillment || undefined) as FulfillmentType | undefined,
    q: q || undefined,
  });

  return (
    <div>
      <PageHeader title="Orders" description="Track and fulfil customer orders." />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="w-full sm:w-48">
              <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
            </div>
            <div className="w-full sm:w-44">
              <Select value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} options={FULFILLMENT_OPTIONS} />
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order #…" className="pl-8" />
          </div>
        </div>

        <Card>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState error={error} onRetry={() => refetch()} />
          ) : !data || data.data.length === 0 ? (
            <EmptyState icon={ShoppingCart} title="No orders found" description="Orders placed by customers will appear here." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Order</TH>
                  <TH>Customer</TH>
                  <TH>Items</TH>
                  <TH>Fulfilment</TH>
                  <TH>Status</TH>
                  <TH>Total</TH>
                  <TH>Date</TH>
                </TR>
              </THead>
              <TBody>
                {data.data.map((o) => (
                  <TR key={o.id} className="cursor-pointer" onClick={() => setOpenId(o.id)}>
                    <TD className="font-medium">{o.orderNumber}</TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Avatar name={o.client?.name ?? 'Customer'} src={o.client?.avatarUrl} size="sm" />
                        <span className="truncate">{o.client?.name ?? '—'}</span>
                      </div>
                    </TD>
                    <TD className="text-muted-foreground">{o.items?.length ?? 0} item(s)</TD>
                    <TD>{humanizeEnum(o.fulfillmentType)}</TD>
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
        </Card>

        {data && data.data.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {data.data.length} of {data.pagination.total} orders
          </p>
        )}
      </div>

      <OrderDetailDrawer orderId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
