'use client';

import { useState, type FormEvent } from 'react';
import { Ban, CheckCircle2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { humanizeEnum } from '@/lib/format';
import { useCancelOrder, useConfirmOrder, useFulfillOrder, useUpdateOrderStatus } from '@/hooks/use-orders';
import type { Order, OrderStatus } from '@/lib/types';

/** Allowed forward transitions handled by the generic status endpoint. */
const NEXT_STATUSES: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PENDING_PAYMENT: ['PAID'],
  PAID: ['PROCESSING'],
  PROCESSING: ['READY_FOR_PICKUP', 'SHIPPED'],
  READY_FOR_PICKUP: ['DELIVERED'],
  SHIPPED: ['DELIVERED'],
};

const TERMINAL: OrderStatus[] = ['DELIVERED', 'CANCELLED', 'REFUNDED'];

export function OrderStatusControl({ order }: { order: Order }) {
  const confirm = useConfirmOrder();
  const fulfill = useFulfillOrder();
  const advance = useUpdateOrderStatus();
  const cancel = useCancelOrder();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(true);
  const [shipStatus, setShipStatus] = useState<OrderStatus | null>(null);
  const [tracking, setTracking] = useState('');

  const nexts = NEXT_STATUSES[order.status] ?? [];
  const isTerminal = TERMINAL.includes(order.status);

  const advanceTo = (status: OrderStatus) => {
    // Shipping needs a tracking number; collect it via the small modal.
    if (status === 'SHIPPED') {
      setShipStatus(status);
      return;
    }
    advance.mutate({ id: order.id, status });
  };

  const submitShip = (e: FormEvent) => {
    e.preventDefault();
    if (!shipStatus) return;
    advance.mutate(
      { id: order.id, status: shipStatus, trackingNumber: tracking.trim() || undefined },
      {
        onSuccess: () => {
          setShipStatus(null);
          setTracking('');
        },
      },
    );
  };

  const submitCancel = (e: FormEvent) => {
    e.preventDefault();
    cancel.mutate(
      { id: order.id, reason: reason.trim(), refundPayment: refund },
      { onSuccess: () => setCancelOpen(false) },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {order.status === 'DRAFT' && (
        <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate({ id: order.id })}>
          <CheckCircle2 className="h-4 w-4" /> Confirm order
        </Button>
      )}

      {(order.status === 'PAID' || order.status === 'PROCESSING') && (
        <Button size="sm" variant="outline" loading={fulfill.isPending} onClick={() => fulfill.mutate({ id: order.id })}>
          <Truck className="h-4 w-4" /> Mark fulfilled
        </Button>
      )}

      {nexts.map((s) => (
        <Button key={s} size="sm" variant="secondary" loading={advance.isPending} onClick={() => advanceTo(s)}>
          Mark {humanizeEnum(s)}
        </Button>
      ))}

      {!isTerminal && (
        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setCancelOpen(true)}>
          <Ban className="h-4 w-4" /> Cancel
        </Button>
      )}

      {/* Shipping tracking prompt */}
      <Modal
        open={!!shipStatus}
        onClose={() => setShipStatus(null)}
        title="Mark as shipped"
        description="Add a tracking number so the customer can follow their order."
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setShipStatus(null)}>
              Cancel
            </Button>
            <Button type="submit" form="ship-form" loading={advance.isPending}>
              Mark shipped
            </Button>
          </>
        }
      >
        <form id="ship-form" onSubmit={submitShip}>
          <Field label="Tracking number" hint="Optional">
            <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. EKART-12345678" />
          </Field>
        </form>
      </Modal>

      {/* Cancel prompt */}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel order"
        description={`Order ${order.orderNumber} will be cancelled.`}
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setCancelOpen(false)}>
              Keep order
            </Button>
            <Button variant="danger" type="submit" form="cancel-form" loading={cancel.isPending} disabled={!reason.trim()}>
              Cancel order
            </Button>
          </>
        }
      >
        <form id="cancel-form" onSubmit={submitCancel} className="space-y-4">
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this order being cancelled?" required />
          </Field>
          {order.paymentId && (
            <Switch checked={refund} onChange={setRefund} label="Refund payment" description="Issue a refund for any captured amount." />
          )}
          {cancel.isError && <p className="text-sm text-danger">Couldn’t cancel the order. Please try again.</p>}
        </form>
      </Modal>
    </div>
  );
}
