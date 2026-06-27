'use client';

import { useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { CalendarClock, CheckCircle2, Clock, User, UserX } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { useBooking, useCancelBooking, useCompleteBooking, useUpdateBooking } from '@/hooks/use-bookings';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';

const PAYMENT_TONE = { PAID: 'success', PARTIAL: 'warning', UNPAID: 'neutral', REFUNDED: 'info' } as const;

export function BookingDetailDrawer({ bookingId, onClose }: { bookingId: string | null; onClose: () => void }) {
  const { data: booking, isLoading, isError, error, refetch } = useBooking(bookingId);
  const update = useUpdateBooking();
  const cancel = useCancelBooking();
  const complete = useCompleteBooking();

  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [newTime, setNewTime] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState(false);

  const isTerminal = booking ? ['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(booking.status) : false;

  const submitReschedule = (e: FormEvent) => {
    e.preventDefault();
    if (!booking || !newTime) return;
    update.mutate(
      { id: booking.id, body: { startTime: new Date(newTime).toISOString() } },
      {
        onSuccess: () => {
          setRescheduleOpen(false);
          setNewTime('');
        },
      },
    );
  };

  const submitCancel = (e: FormEvent) => {
    e.preventDefault();
    if (!booking) return;
    cancel.mutate(
      { id: booking.id, reason: reason.trim() || undefined, refundPayment: refund },
      { onSuccess: () => setCancelOpen(false) },
    );
  };

  return (
    <Drawer
      open={!!bookingId}
      onClose={onClose}
      title={booking ? (booking.service?.name ?? 'Booking') : 'Booking'}
      description={booking ? formatDateTimeIST(booking.startTime) : undefined}
      footer={
        booking && !isTerminal ? (
          <>
            {(booking.status === 'PENDING' || booking.status === 'RESCHEDULED') && (
              <Button
                size="sm"
                loading={update.isPending}
                onClick={() => update.mutate({ id: booking.id, body: { status: 'CONFIRMED' } })}
              >
                <CheckCircle2 className="h-4 w-4" /> Confirm
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setNewTime(format(new Date(booking.startTime), "yyyy-MM-dd'T'HH:mm"));
                setRescheduleOpen(true);
              }}
            >
              <Clock className="h-4 w-4" /> Reschedule
            </Button>
            <Button size="sm" variant="secondary" loading={complete.isPending} onClick={() => complete.mutate({ id: booking.id })}>
              Complete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={update.isPending}
              onClick={() => update.mutate({ id: booking.id, body: { status: 'NO_SHOW' } })}
            >
              <UserX className="h-4 w-4" /> No-show
            </Button>
            <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setCancelOpen(true)}>
              Cancel
            </Button>
          </>
        ) : undefined
      }
    >
      {isLoading || !bookingId ? (
        <LoadingState label="Loading booking…" />
      ) : isError || !booking ? (
        <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <StatusBadge value={booking.status} />
            <Badge tone={PAYMENT_TONE[booking.paymentStatus] ?? 'neutral'}>{humanizeEnum(booking.paymentStatus)}</Badge>
          </div>

          <section className="rounded-lg border border-border p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <User className="h-3.5 w-3.5" /> Client
            </p>
            <div className="flex items-center gap-3">
              <Avatar name={booking.client?.name ?? 'Client'} src={booking.client?.avatarUrl} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{booking.client?.name ?? '—'}</p>
                <p className="truncate text-xs text-muted-foreground">{booking.client?.phone ?? booking.client?.email ?? '—'}</p>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Starts" value={formatDateTimeIST(booking.startTime)} />
            <Detail label="Ends" value={formatDateTimeIST(booking.endTime)} />
            <Detail label="Duration" value={`${booking.durationMinutes} min`} />
            <Detail label="Price" value={paiseToRupees(booking.price)} />
          </section>

          {(booking.notes || booking.clientNotes) && (
            <section className="space-y-3">
              {booking.notes && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Internal notes</p>
                  <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{booking.notes}</p>
                </div>
              )}
              {booking.clientNotes && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Client notes</p>
                  <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{booking.clientNotes}</p>
                </div>
              )}
            </section>
          )}

          {booking.cancelReason && (
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <CalendarClock className="h-3.5 w-3.5" /> Cancelled: {booking.cancelReason}
            </p>
          )}
        </div>
      )}

      {/* Reschedule modal */}
      <Modal
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        title="Reschedule booking"
        description="Pick a new start time. The client will be notified."
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setRescheduleOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="reschedule-form" loading={update.isPending} disabled={!newTime}>
              Reschedule
            </Button>
          </>
        }
      >
        <form id="reschedule-form" onSubmit={submitReschedule}>
          <Field label="New date & time">
            <Input type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} required />
          </Field>
        </form>
      </Modal>

      {/* Cancel modal */}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel booking"
        description="The client will be notified of the cancellation."
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setCancelOpen(false)}>
              Keep booking
            </Button>
            <Button variant="danger" type="submit" form="cancel-booking-form" loading={cancel.isPending}>
              Cancel booking
            </Button>
          </>
        }
      >
        <form id="cancel-booking-form" onSubmit={submitCancel} className="space-y-4">
          <Field label="Reason" hint="Optional">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why is this booking being cancelled?" />
          </Field>
          {booking?.paymentStatus === 'PAID' && (
            <Switch checked={refund} onChange={setRefund} label="Refund payment" description="Issue a refund for this booking." />
          )}
        </form>
      </Modal>
    </Drawer>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}
