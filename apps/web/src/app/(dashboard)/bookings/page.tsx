'use client';

import { useState } from 'react';
import { CalendarClock, Plus, SlidersHorizontal } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { SegmentedTabs } from '@/components/ui/tabs';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { BookingCalendar } from '@/components/bookings/booking-calendar';
import { CreateBookingModal } from '@/components/bookings/create-booking-modal';
import { BookingDetailDrawer } from '@/components/bookings/booking-detail-drawer';
import { AvailabilitySettings } from '@/components/bookings/availability-settings';
import { useBookings } from '@/hooks/use-bookings';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import type { BookingStatus } from '@/lib/types';
import { usePermissions } from '@/hooks/use-permissions';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['CONFIRMED', 'PENDING', 'RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map((v) => ({
    label: humanizeEnum(v),
    value: v,
  })),
];

const PAYMENT_TONE = {
  PAID: 'success',
  PARTIAL: 'warning',
  UNPAID: 'neutral',
  REFUNDED: 'info',
} as const;

export default function BookingsPage() {
  // Undecorated writes — STAFF and above.
  const { canWrite } = usePermissions();

  const [view, setView] = useState('calendar');
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const listQ = useBookings({
    status: (status || undefined) as BookingStatus | undefined,
    include: 'client',
    limit: 50,
  });

  return (
    <div>
      <PageHeader
        title="Bookings"
        description="Appointments, availability and your calendar."
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setAvailabilityOpen(true)}>
                <SlidersHorizontal className="h-4 w-4" /> Availability
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New booking
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedTabs
            items={[
              { key: 'calendar', label: 'Calendar' },
              { key: 'list', label: 'List' },
            ]}
            activeKey={view}
            onChange={setView}
          />
          {view === 'list' && (
            <div className="w-full sm:w-48">
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={STATUS_OPTIONS}
              />
            </div>
          )}
        </div>

        {view === 'calendar' ? (
          <BookingCalendar onSelectBooking={setDetailId} />
        ) : (
          <Card>
            {listQ.isLoading ? (
              <LoadingState />
            ) : listQ.isError ? (
              <ErrorState
                error={listQ.error}
                onRetry={() => listQ.refetch()}
              />
            ) : !listQ.data || listQ.data.data.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title="No bookings found"
                description="Appointments will appear here once booked."
                action={
                  canWrite ? (
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="h-4 w-4" /> New booking
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Client</TH>
                    <TH>Service</TH>
                    <TH>When</TH>
                    <TH>Status</TH>
                    <TH>Payment</TH>
                    <TH>Price</TH>
                  </TR>
                </THead>
                <TBody>
                  {listQ.data.data.map((b) => (
                    <TR key={b.id} className="cursor-pointer" onClick={() => setDetailId(b.id)}>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Avatar
                            name={b.client?.name ?? 'Client'}
                            src={b.client?.avatarUrl}
                            size="sm"
                          />
                          <span className="font-medium">{b.client?.name ?? '—'}</span>
                        </div>
                      </TD>
                      <TD>{b.service?.name ?? '—'}</TD>
                      <TD className="text-muted-foreground">{formatDateTimeIST(b.startTime)}</TD>
                      <TD>
                        <StatusBadge value={b.status} />
                      </TD>
                      <TD>
                        <Badge tone={PAYMENT_TONE[b.paymentStatus] ?? 'neutral'}>
                          {humanizeEnum(b.paymentStatus)}
                        </Badge>
                      </TD>
                      <TD className="font-medium">{paiseToRupees(b.price)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        )}
      </div>

      <CreateBookingModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <AvailabilitySettings open={availabilityOpen} onClose={() => setAvailabilityOpen(false)} />
      <BookingDetailDrawer bookingId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
