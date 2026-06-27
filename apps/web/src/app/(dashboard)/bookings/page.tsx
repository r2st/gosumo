'use client';

import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { useBookings } from '@/hooks/use-queries';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import type { BookingStatus } from '@/lib/types';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['CONFIRMED', 'PENDING', 'RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map((v) => ({
    label: humanizeEnum(v),
    value: v,
  })),
];

const PAYMENT_TONE = { PAID: 'success', PARTIAL: 'warning', UNPAID: 'neutral', REFUNDED: 'info' } as const;

export default function BookingsPage() {
  const [status, setStatus] = useState('');
  const { data, isLoading, isError, error, refetch } = useBookings({
    status: (status || undefined) as BookingStatus | undefined,
    include: 'client',
    limit: 50,
  });

  return (
    <div>
      <PageHeader title="Bookings" description="Upcoming and past appointments." />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="w-full sm:w-48">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
        </div>

        <Card>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
          ) : !data || data.data.length === 0 ? (
            <EmptyState icon={CalendarClock} title="No bookings found" description="Appointments will appear here once booked." />
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
                {data.data.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Avatar name={b.client?.name ?? 'Client'} src={b.client?.avatarUrl} size="sm" />
                        <span className="font-medium">{b.client?.name ?? '—'}</span>
                      </div>
                    </TD>
                    <TD>{b.service?.name ?? '—'}</TD>
                    <TD className="text-muted-foreground">{formatDateTimeIST(b.startTime)}</TD>
                    <TD>
                      <StatusBadge value={b.status} />
                    </TD>
                    <TD>
                      <Badge tone={PAYMENT_TONE[b.paymentStatus] ?? 'neutral'}>{humanizeEnum(b.paymentStatus)}</Badge>
                    </TD>
                    <TD className="font-medium">{paiseToRupees(b.price)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
