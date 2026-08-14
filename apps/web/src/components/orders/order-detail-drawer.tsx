'use client';

import {
  Ban,
  CheckCircle2,
  CircleDot,
  CreditCard,
  MapPin,
  Package,
  ShoppingCart,
  Truck,
  User,
} from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { OrderStatusControl } from '@/components/orders/order-status-control';
import { useOrder } from '@/hooks/use-orders';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import type { OrderAddress, OrderDetail } from '@/lib/commerce-types';
import type { LucideIcon } from 'lucide-react';

interface TimelineStep {
  label: string;
  at?: string;
  icon: LucideIcon;
  tone: string;
}

function buildTimeline(order: OrderDetail): TimelineStep[] {
  const steps: TimelineStep[] = [
    { label: 'Order placed', at: order.createdAt, icon: ShoppingCart, tone: 'text-sky-600 bg-sky-50' },
    { label: 'Confirmed', at: order.confirmedAt, icon: CheckCircle2, tone: 'text-emerald-600 bg-emerald-50' },
    { label: 'Shipped', at: order.shippedAt, icon: Truck, tone: 'text-violet-600 bg-violet-50' },
    { label: 'Delivered', at: order.deliveredAt, icon: Package, tone: 'text-emerald-600 bg-emerald-50' },
  ];
  if (order.cancelledAt) {
    steps.push({ label: 'Cancelled', at: order.cancelledAt, icon: Ban, tone: 'text-rose-600 bg-rose-50' });
  }
  return steps.filter((s) => s.at);
}

function AddressBlock({ title, address }: { title: string; address: OrderAddress }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm font-medium">{address.name}</p>
      <p className="text-sm text-muted-foreground">{address.phone}</p>
      <p className="text-sm text-muted-foreground">
        {[address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', ')}
      </p>
    </div>
  );
}

export function OrderDetailDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const { data: order, isLoading, isError, error, refetch } = useOrder(orderId);

  return (
    <Drawer
      open={!!orderId}
      onClose={onClose}
      title={order ? order.orderNumber : 'Order'}
      description={order ? `${order.items.length} item(s) · ${paiseToRupees(order.total)}` : undefined}
      footer={order ? <OrderStatusControl order={order} /> : undefined}
    >
      {isLoading || !orderId ? (
        <LoadingState label="Loading order…" />
      ) : isError || !order ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <StatusBadge value={order.status} />
            <Badge tone="info">{humanizeEnum(order.fulfillmentType)}</Badge>
          </div>

          {/* Customer */}
          <section className="rounded-lg border border-border p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <User className="h-3.5 w-3.5" /> Customer
            </p>
            <div className="flex items-center gap-3">
              <Avatar name={order.client?.name ?? 'Customer'} src={order.client?.avatarUrl} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{order.client?.name ?? '—'}</p>
                <p className="truncate text-xs text-muted-foreground">{order.client?.phone ?? order.client?.email ?? '—'}</p>
              </div>
            </div>
          </section>

          {/* Items */}
          <section>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Items</p>
            <div className="divide-y divide-border rounded-lg border border-border">
              {order.items.map((it) => (
                <div key={it.id} className="flex items-center gap-3 p-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.imageUrl} alt={it.name} className="h-full w-full object-cover" />
                    ) : (
                      <Package className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.quantity} × {paiseToRupees(it.unitPrice)}
                      {it.sku ? ` · ${it.sku}` : ''}
                    </p>
                  </div>
                  <p className="text-sm font-medium">{paiseToRupees(it.total)}</p>
                </div>
              ))}
            </div>

            {/* Totals */}
            <dl className="mt-3 space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
              <Row label="Subtotal" value={paiseToRupees(order.subtotal)} />
              {order.discountAmount > 0 && <Row label="Discount" value={`− ${paiseToRupees(order.discountAmount)}`} />}
              {order.taxAmount > 0 && <Row label="Tax" value={paiseToRupees(order.taxAmount)} />}
              {order.shippingAmount > 0 && <Row label="Shipping" value={paiseToRupees(order.shippingAmount)} />}
              <div className="border-t border-border pt-1.5">
                <Row label="Total" value={paiseToRupees(order.total)} bold />
              </div>
            </dl>
          </section>

          {/* Payment & shipping */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <CreditCard className="h-3.5 w-3.5" /> Payment
              </p>
              {order.paymentId ? (
                <p className="font-mono text-xs text-muted-foreground">{order.paymentId.slice(0, 12)}…</p>
              ) : (
                <p className="text-sm text-muted-foreground">No payment linked</p>
              )}
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Truck className="h-3.5 w-3.5" /> Shipping
              </p>
              {order.trackingNumber ? (
                <p className="text-sm">Tracking: <span className="font-mono">{order.trackingNumber}</span></p>
              ) : (
                <p className="text-sm text-muted-foreground">Not shipped yet</p>
              )}
            </div>
          </section>

          {(order.shippingAddress || order.billingAddress) && (
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:col-span-2">
                <MapPin className="h-3.5 w-3.5" /> Addresses
              </p>
              {order.shippingAddress && <AddressBlock title="Shipping" address={order.shippingAddress} />}
              {order.billingAddress && <AddressBlock title="Billing" address={order.billingAddress} />}
            </section>
          )}

          {order.notes && (
            <section>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</p>
              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{order.notes}</p>
            </section>
          )}

          {/* Timeline */}
          <section>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
            <ol className="relative space-y-4 border-l border-border pl-6">
              {buildTimeline(order).map((step, idx) => {
                const Icon = step.icon;
                return (
                  <li key={idx} className="relative">
                    <span className={`absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border border-border ${step.tone}`}>
                      <Icon className="h-3 w-3" />
                    </span>
                    <p className="text-sm font-medium">{step.label}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTimeIST(step.at)}</p>
                  </li>
                );
              })}
              {buildTimeline(order).length === 0 && (
                <li className="relative">
                  <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card">
                    <CircleDot className="h-3 w-3 text-muted-foreground" />
                  </span>
                  <p className="text-sm text-muted-foreground">No status changes yet.</p>
                </li>
              )}
            </ol>
            {order.cancelReason && <p className="mt-3 text-xs text-danger">Cancellation reason: {order.cancelReason}</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={bold ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={bold ? 'font-bold' : 'font-medium'}>{value}</dd>
    </div>
  );
}
