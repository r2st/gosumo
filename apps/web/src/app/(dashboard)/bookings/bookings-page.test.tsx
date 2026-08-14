/**
 * The bookings page — calendar/list switch, the status filter, and the three
 * overlays it owns.
 *
 * The calendar, the create modal, the availability sheet and the detail drawer
 * each have their own tests, so what is left here is the page's own wiring: the
 * status filter only exists in list view (and must actually reach the query, not
 * just the input), a row click has to open the drawer with *that* booking's id,
 * and every write affordance — the two header buttons and the empty-state
 * button — is gated on `canWrite`, which is easy to apply to the header and
 * forget on the empty state.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '@/lib/types';
import type { Role } from '@/lib/feature-types';

let bookings: Booking[] | undefined = [];
let listState = { isLoading: false, isError: false };
let role: Role = 'STAFF';
const refetch = vi.fn();
const bookingsFilters: Array<Record<string, unknown>> = [];

vi.mock('@/hooks/use-bookings', () => ({
  useBookings: (filters: Record<string, unknown>) => {
    bookingsFilters.push(filters);
    return {
      data: bookings ? { data: bookings, pagination: { total: bookings.length } } : undefined,
      isLoading: listState.isLoading,
      isError: listState.isError,
      error: listState.isError ? new Error('boom') : undefined,
      refetch,
    };
  },
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

const selectBookingRef: { current: ((id: string) => void) | null } = { current: null };

vi.mock('@/components/bookings/booking-calendar', () => ({
  BookingCalendar: ({ onSelectBooking }: { onSelectBooking: (id: string) => void }) => {
    selectBookingRef.current = onSelectBooking;
    return <div data-testid="calendar" />;
  },
}));

// Each stub exposes its own close control, so the page's `onClose` handlers —
// the things that actually reset the page's state — are reachable from a test.
vi.mock('@/components/bookings/create-booking-modal', () => ({
  CreateBookingModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="create-modal">
        <button onClick={onClose}>close create</button>
      </div>
    ) : null,
}));
vi.mock('@/components/bookings/availability-settings', () => ({
  AvailabilitySettings: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="availability">
        <button onClick={onClose}>close availability</button>
      </div>
    ) : null,
}));
vi.mock('@/components/bookings/booking-detail-drawer', () => ({
  BookingDetailDrawer: ({
    bookingId,
    onClose,
  }: {
    bookingId: string | null;
    onClose: () => void;
  }) =>
    bookingId ? (
      <div data-testid="detail-drawer">
        {bookingId}
        <button onClick={onClose}>close drawer</button>
      </div>
    ) : null,
}));

import BookingsPage from './page';

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'bk-1',
    businessId: 'b1',
    clientId: 'cl1',
    catalogItemId: 'ci1',
    status: 'CONFIRMED',
    startTime: '2026-08-20T04:30:00.000Z',
    endTime: '2026-08-20T05:30:00.000Z',
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
    price: 250_000,
    currency: 'INR',
    paymentStatus: 'PAID',
    reminderSent: false,
    metadata: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    client: { id: 'cl1', name: 'Asha Rao', avatarUrl: null },
    service: { id: 'ci1', name: 'Site visit — Prestige Lakeside' },
    ...overrides,
  } as Booking;
}

/** Switch to the list view, which is where every table assertion lives. */
const showList = () => fireEvent.click(screen.getByRole('button', { name: 'List' }));

beforeEach(() => {
  vi.clearAllMocks();
  bookings = [makeBooking()];
  listState = { isLoading: false, isError: false };
  role = 'STAFF';
  bookingsFilters.length = 0;
  selectBookingRef.current = null;
});

describe('BookingsPage views', () => {
  it('opens on the calendar, not the table', () => {
    render(<BookingsPage />);

    expect(screen.getByTestId('calendar')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('swaps the calendar for the table on demand', () => {
    render(<BookingsPage />);
    showList();

    expect(screen.queryByTestId('calendar')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('offers the status filter only where it applies', () => {
    render(<BookingsPage />);
    // The calendar renders its own range; a status dropdown there would do nothing.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    showList();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('pushes the chosen status into the query rather than filtering in the browser', () => {
    render(<BookingsPage />);
    showList();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CANCELLED' } });

    expect(bookingsFilters.at(-1)).toMatchObject({ status: 'CANCELLED', limit: 50 });
  });

  it('sends no status at all for "All statuses"', () => {
    render(<BookingsPage />);

    // An empty string would filter to bookings with a blank status — the page
    // has to drop the key entirely.
    expect(bookingsFilters.at(-1)).toMatchObject({ status: undefined });
  });
});

describe('BookingsPage list', () => {
  it('renders a booking with its client, service, time and price', () => {
    render(<BookingsPage />);
    showList();

    const row = screen.getByText('Asha Rao').closest('tr')!;
    expect(within(row).getByText('Site visit — Prestige Lakeside')).toBeInTheDocument();
    // 250,000 paise = ₹2,500.00 — the table shows full rupees, not the
    // compact form the KPI tiles use.
    expect(within(row).getByText('₹2,500.00')).toBeInTheDocument();
    expect(within(row).getByText('Paid')).toBeInTheDocument();
  });

  it('falls back to a dash when the client or service failed to expand', () => {
    bookings = [makeBooking({ client: undefined, service: undefined } as Partial<Booking>)];
    render(<BookingsPage />);
    showList();

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the drawer for the row that was clicked', () => {
    bookings = [makeBooking(), makeBooking({ id: 'bk-2', client: { id: 'cl2', name: 'Vikram Nair' } } as Partial<Booking>)];
    render(<BookingsPage />);
    showList();

    fireEvent.click(screen.getByText('Vikram Nair').closest('tr')!);

    expect(screen.getByTestId('detail-drawer')).toHaveTextContent('bk-2');
  });

  it('clears the selected booking on close, so the same row reopens', () => {
    // If closing left `detailId` set, clicking the same row again would be a
    // no-op — the state never changes, so nothing re-renders.
    bookings = [makeBooking()];
    render(<BookingsPage />);
    showList();

    fireEvent.click(screen.getByText('Asha Rao').closest('tr')!);
    fireEvent.click(screen.getByText('close drawer'));
    expect(screen.queryByTestId('detail-drawer')).toBeNull();

    fireEvent.click(screen.getByText('Asha Rao').closest('tr')!);
    expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
  });

  it('opens the drawer from a calendar selection too', () => {
    render(<BookingsPage />);

    act(() => selectBookingRef.current!('bk-from-calendar'));

    expect(screen.getByTestId('detail-drawer')).toHaveTextContent('bk-from-calendar');
  });

  it('shows the loading state while the list is in flight', () => {
    listState = { isLoading: true, isError: false };
    render(<BookingsPage />);
    showList();

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the list request failed', () => {
    listState = { isLoading: false, isError: true };
    render(<BookingsPage />);
    showList();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('treats a missing payload as an empty list', () => {
    bookings = undefined;
    render(<BookingsPage />);
    showList();

    expect(screen.getByText('No bookings found')).toBeInTheDocument();
  });
});

describe('BookingsPage write gating', () => {
  it('lets a staff member open both header actions', () => {
    render(<BookingsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Availability/ }));
    expect(screen.getByTestId('availability')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New booking/ }));
    expect(screen.getByTestId('create-modal')).toBeInTheDocument();
  });

  it('closes each dialog and can reopen it', () => {
    // A close handler that fails to reset the flag leaves the dialog stuck
    // open; one that resets the wrong flag makes the second open a no-op.
    // Both look identical until you actually close and reopen.
    render(<BookingsPage />);

    fireEvent.click(screen.getByRole('button', { name: /New booking/ }));
    fireEvent.click(screen.getByText('close create'));
    expect(screen.queryByTestId('create-modal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /New booking/ }));
    expect(screen.getByTestId('create-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Availability/ }));
    fireEvent.click(screen.getByText('close availability'));
    expect(screen.queryByTestId('availability')).toBeNull();
    // Closing availability must not have closed the create modal with it.
    expect(screen.getByTestId('create-modal')).toBeInTheDocument();
  });

  it('offers the empty state its own create button', () => {
    bookings = [];
    render(<BookingsPage />);
    showList();

    fireEvent.click(within(screen.getByText('No bookings found').closest('div')!).getByRole('button'));
    expect(screen.getByTestId('create-modal')).toBeInTheDocument();
  });

  it('hides every create affordance from a VIEWER', () => {
    role = 'VIEWER';
    bookings = [];
    render(<BookingsPage />);
    showList();

    // Both the header pair and the empty-state button are gated — the empty
    // state is the one that is easy to leave behind.
    expect(screen.queryByRole('button', { name: /New booking/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Availability/ })).not.toBeInTheDocument();
    expect(screen.getByText('No bookings found')).toBeInTheDocument();
  });
});
