'use client';

import { FileText, Printer } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/states';
import { useOrder } from '@/hooks/use-orders';
import { useBusinessProfile } from '@/hooks/use-settings';
import { formatDateIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import { invoiceNumber } from '@/lib/commerce-types';
import type { Payment } from '@/lib/types';

const STATUS_TONE = { CAPTURED: 'success', PARTIALLY_REFUNDED: 'warning', REFUNDED: 'neutral' } as const;

/**
 * Renders a captured payment as a printable invoice document. Line items are
 * pulled from the linked order when present; otherwise the payment amount is
 * shown as a single line.
 */
export function InvoiceDetailDrawer({ payment, onClose }: { payment: Payment | null; onClose: () => void }) {
  const orderQ = useOrder(payment?.orderId ?? null);
  const businessQ = useBusinessProfile();
  const business = businessQ.data;
  const order = orderQ.data;

  return (
    <Drawer
      open={!!payment}
      onClose={onClose}
      title={payment ? invoiceNumber(payment) : 'Invoice'}
      description={payment ? formatDateIST(payment.capturedAt ?? payment.createdAt) : undefined}
      footer={
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print
        </Button>
      }
    >
      {!payment ? (
        <LoadingState />
      ) : (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <p className="flex items-center gap-1.5 text-lg font-bold">
                <FileText className="h-5 w-5 text-muted-foreground" /> Invoice
              </p>
              <p className="text-sm text-muted-foreground">{invoiceNumber(payment)}</p>
            </div>
            <Badge tone={STATUS_TONE[payment.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
              {humanizeEnum(payment.status)}
            </Badge>
          </div>

          {/* From / To */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">From</p>
              <p className="mt-1 font-medium">{business?.name ?? 'Your business'}</p>
              {business?.email && <p className="text-muted-foreground">{business.email}</p>}
              {business?.phone && <p className="text-muted-foreground">{business.phone}</p>}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Billed to</p>
              <p className="mt-1 font-medium">{payment.client?.name ?? '—'}</p>
              {payment.client?.email && <p className="text-muted-foreground">{payment.client.email}</p>}
              {payment.client?.phone && <p className="text-muted-foreground">{payment.client.phone}</p>}
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="grid grid-cols-12 gap-2 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span className="col-span-6">Description</span>
              <span className="col-span-2 text-right">Qty</span>
              <span className="col-span-4 text-right">Amount</span>
            </div>
            {orderQ.isLoading && payment.orderId ? (
              <LoadingState className="py-6" />
            ) : order && order.items.length > 0 ? (
              order.items.map((it) => (
                <div key={it.id} className="grid grid-cols-12 gap-2 border-b border-border py-2 text-sm">
                  <span className="col-span-6">{it.name}</span>
                  <span className="col-span-2 text-right text-muted-foreground">{it.quantity}</span>
                  <span className="col-span-4 text-right font-medium">{paiseToRupees(it.total)}</span>
                </div>
              ))
            ) : (
              <div className="grid grid-cols-12 gap-2 border-b border-border py-2 text-sm">
                <span className="col-span-6">Payment</span>
                <span className="col-span-2 text-right text-muted-foreground">1</span>
                <span className="col-span-4 text-right font-medium">{paiseToRupees(payment.amount)}</span>
              </div>
            )}

            {/* Totals */}
            <dl className="mt-3 space-y-1.5 text-sm">
              {order && (
                <>
                  <TotalRow label="Subtotal" value={paiseToRupees(order.subtotal)} />
                  {order.discountAmount > 0 && <TotalRow label="Discount" value={`− ${paiseToRupees(order.discountAmount)}`} />}
                  {order.taxAmount > 0 && <TotalRow label="Tax" value={paiseToRupees(order.taxAmount)} />}
                  {order.shippingAmount > 0 && <TotalRow label="Shipping" value={paiseToRupees(order.shippingAmount)} />}
                </>
              )}
              <div className="border-t border-border pt-1.5">
                <TotalRow label="Total paid" value={paiseToRupees(payment.amount)} bold />
              </div>
            </dl>
          </div>

          {payment.method && (
            <p className="text-xs text-muted-foreground">Paid via {humanizeEnum(payment.method)}.</p>
          )}
        </div>
      )}
    </Drawer>
  );
}

function TotalRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={bold ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={bold ? 'font-bold' : 'font-medium'}>{value}</dd>
    </div>
  );
}
