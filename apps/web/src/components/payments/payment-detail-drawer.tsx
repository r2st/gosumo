'use client';

import { useState, type FormEvent } from 'react';
import { ExternalLink, RotateCcw, User, Wallet } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { useCapturePayment, usePayment, useRefundPayment } from '@/hooks/use-payments';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import { rupeesToPaise } from '@/lib/money';
import { usePermissions } from '@/hooks/use-permissions';

const REFUND_TONE = { PROCESSED: 'success', PENDING: 'warning', FAILED: 'danger' } as const;

export function PaymentDetailDrawer({
  paymentId,
  onClose,
}: {
  paymentId: string | null;
  onClose: () => void;
}) {
  const { data: payment, isLoading, isError, error, refetch } = usePayment(paymentId);
  const refund = useRefundPayment();
  const capture = useCapturePayment();
  // Capturing and refunding are undecorated writes — STAFF and above.
  const { canWrite } = usePermissions();

  const [refundOpen, setRefundOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const refundedSoFar = (payment?.refunds ?? []).reduce(
    (sum, r) => (r.status !== 'FAILED' ? sum + r.amount : sum),
    0,
  );
  const refundable = payment ? Math.max(0, payment.amount - refundedSoFar) : 0;
  const canRefund = payment
    ? ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status) && refundable > 0
    : false;
  const canCapture = payment?.status === 'AUTHORIZED';

  const submitRefund = (e: FormEvent) => {
    e.preventDefault();
    if (!payment) return;
    refund.mutate(
      { id: payment.id, amount: rupeesToPaise(amount), reason: reason.trim() },
      {
        onSuccess: () => {
          setRefundOpen(false);
          setAmount('');
          setReason('');
        },
      },
    );
  };

  return (
    <Drawer
      open={!!paymentId}
      onClose={onClose}
      title={payment ? paiseToRupees(payment.amount) : 'Payment'}
      description={
        payment
          ? `${humanizeEnum(payment.status)} · ${formatDateTimeIST(payment.createdAt)}`
          : undefined
      }
      footer={
        payment ? (
          <>
            {canWrite && canCapture && (
              <Button
                size="sm"
                loading={capture.isPending}
                onClick={() => capture.mutate({ id: payment.id })}
              >
                <Wallet className="h-4 w-4" /> Capture
              </Button>
            )}
            {canWrite && canRefund && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAmount((refundable / 100).toString());
                  setRefundOpen(true);
                }}
              >
                <RotateCcw className="h-4 w-4" /> Refund
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {isLoading || !paymentId ? (
        <LoadingState label="Loading payment…" />
      ) : isError || !payment ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <StatusBadge value={payment.status} />
            {payment.method && <Badge tone="info">{humanizeEnum(payment.method)}</Badge>}
          </div>

          {/* Transaction info */}
          <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
            <Row label="Payment ID" value={payment.id} mono />
            {payment.orderId && <Row label="Order" value={payment.orderId} mono />}
            {payment.bookingId && <Row label="Booking" value={payment.bookingId} mono />}
            <Row label="Amount" value={paiseToRupees(payment.amount)} />
            {refundedSoFar > 0 && <Row label="Refunded" value={paiseToRupees(refundedSoFar)} />}
            {payment.capturedAt && (
              <Row label="Captured" value={formatDateTimeIST(payment.capturedAt)} />
            )}
            {payment.failureReason && <Row label="Failure" value={payment.failureReason} />}
          </section>

          {/* Client */}
          {payment.client && (
            <section className="rounded-lg border border-border p-4">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <User className="h-3.5 w-3.5" /> Client
              </p>
              <div className="flex items-center gap-3">
                <Avatar name={payment.client.name} src={payment.client.avatarUrl} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{payment.client.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {payment.client.phone ?? payment.client.email ?? '—'}
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Payment link */}
          {(payment.paymentLinkUrl || payment.paymentLinkShortUrl) && (
            <section className="rounded-lg border border-border p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Payment link
              </p>
              <a
                href={payment.paymentLinkShortUrl ?? payment.paymentLinkUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all text-sm text-primary hover:underline"
              >
                {payment.paymentLinkShortUrl ?? payment.paymentLinkUrl}{' '}
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
              {payment.paymentLinkExpiry && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Expires {formatDateTimeIST(payment.paymentLinkExpiry)}
                </p>
              )}
            </section>
          )}

          {/* Refunds */}
          {payment.refunds.length > 0 && (
            <section>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Refunds
              </p>
              <div className="divide-y divide-border rounded-lg border border-border">
                {payment.refunds.map((r) => (
                  <div key={r.id} className="flex items-center justify-between p-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">{paiseToRupees(r.amount)}</p>
                      <p className="truncate text-xs text-muted-foreground">{r.reason}</p>
                    </div>
                    <Badge tone={REFUND_TONE[r.status] ?? 'neutral'}>
                      {humanizeEnum(r.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Refund modal */}
      <Modal
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        title="Issue refund"
        description={payment ? `Up to ${paiseToRupees(refundable)} can be refunded.` : ''}
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setRefundOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              form="refund-form"
              loading={refund.isPending}
              disabled={!amount || !reason.trim()}
            >
              Refund
            </Button>
          </>
        }
      >
        <form id="refund-form" onSubmit={submitRefund} className="space-y-4">
          <Field label="Amount (₹)">
            <Input
              type="number"
              min="1"
              step="0.01"
              max={refundable / 100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
          <Field label="Reason">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why is this being refunded?"
              required
            />
          </Field>
          {refund.isError && (
            <p className="text-sm text-danger">Couldn’t process the refund. Please try again.</p>
          )}
        </form>
      </Modal>
    </Drawer>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'truncate font-mono text-xs' : 'font-medium'}>{value}</span>
    </div>
  );
}
