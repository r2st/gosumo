/**
 * The four booking components: calendar, create modal, detail drawer and the
 * availability settings.
 *
 * Bookings are the surface where a wrong control is a wrong promise to a real
 * customer, so the tests pin the transitions rather than the layout: Confirm
 * only exists for a booking that is not confirmed yet, the whole action rail
 * withdraws once a booking is terminal or the operator is a VIEWER, and the
 * refund toggle only appears on a booking that was actually paid. The calendar
 * covers the range it asks the API for — a week grid must start on Monday and a
 * month grid must pad out to whole weeks — since an off-by-one there silently
 * hides appointments.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, BookingStatus } from '@/lib/types';
import type { CalendarEvent } from '@/lib/commerce-types';
import type { Role } from '@/lib/feature-types';

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'bk-1',
    businessId: 'b1',
    clientId: 'c1',
    catalogItemId: 'i1',
    status: 'PENDING',
    startTime: '2026-08-20T04:30:00.000Z',
    endTime: '2026-08-20T05:15:00.000Z',
    timezone: 'Asia/Kolkata',
    durationMinutes: 45,
    price: 150_000,
    currency: 'INR',
    paymentStatus: 'UNPAID',
    reminderSent: false,
    metadata: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    client: { id: 'c1', name: 'Asha Rao', phone: '+919800000001' },
    service: { id: 'i1', name: 'Deep Tissue Massage' },
    ...overrides,
  } as Booking;
}

const state = {
  booking: {
    data: makeBooking() as Booking | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
  calendar: {
    data: { events: [] as CalendarEvent[] } as { events: CalendarEvent[] } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  slots: {
    data: { slots: [] as Array<{ startTime: string; available: boolean }> } as
      | { slots: Array<{ startTime: string; available: boolean }> }
      | undefined,
    isLoading: false,
  },
  settings: {
    data: {
      bookingEnabled: true,
      defaultSlotDurationMinutes: 30,
      officeHours: {},
    } as Record<string, unknown> | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  clients: { data: { data: [{ id: 'c1', name: 'Asha Rao', phone: '+919800000001' }] } } as {
    data?: { data: Array<{ id: string; name: string; phone?: string | null; email?: string | null }> };
  },
  services: { data: { data: [{ id: 'i1', name: 'Deep Tissue Massage' }] } } as {
    data?: { data: Array<{ id: string; name: string }> };
  },
  staff: { data: { staff: [{ id: 's1', name: 'Meera' }] } } as {
    data?: { staff: Array<{ id: string; name: string }> };
  },
};

const mutations = {
  create: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  updateSettings: vi.fn(),
};
const flags = { createError: false, settingsError: false };
let role: Role = 'STAFF';

/** The calendar range the component last asked the API for. */
let calendarRange: { from: string; to: string } | null = null;
/** The slots query arguments and whether it was enabled. */
let slotArgs: [Record<string, unknown>, boolean] | null = null;

vi.mock('@/hooks/use-bookings', () => ({
  useBooking: () => state.booking,
  useCalendar: (range: { from: string; to: string }) => {
    calendarRange = range;
    return state.calendar;
  },
  useSlots: (args: Record<string, unknown>, enabled: boolean) => {
    slotArgs = [args, enabled];
    return state.slots;
  },
  useStaff: () => state.staff,
  useCreateBooking: () => ({ mutate: mutations.create, isPending: false, isError: flags.createError }),
  useUpdateBooking: () => ({ mutate: mutations.update, isPending: false, isError: false }),
  useCancelBooking: () => ({ mutate: mutations.cancel, isPending: false, isError: false }),
  useCompleteBooking: () => ({ mutate: mutations.complete, isPending: false, isError: false }),
  useBusinessSettings: () => state.settings,
  useUpdateBusinessSettings: () => ({
    mutate: mutations.updateSettings,
    isPending: false,
    isError: flags.settingsError,
  }),
}));

vi.mock('@/hooks/use-queries', () => ({ useClients: () => state.clients }));
vi.mock('@/hooks/use-catalog', () => ({ useCatalogItems: () => state.services }));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import { BookingCalendar } from './booking-calendar';
import { CreateBookingModal } from './create-booking-modal';
import { BookingDetailDrawer } from './booking-detail-drawer';
import { AvailabilitySettings } from './availability-settings';

function makeEvent(id: string, start: string, status: BookingStatus = 'CONFIRMED'): CalendarEvent {
  return {
    id,
    title: `Booking ${id}`,
    start,
    end: start,
    status,
  } as CalendarEvent;
}

beforeEach(() => {
  state.booking = {
    data: makeBooking(),
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  state.calendar = { data: { events: [] }, isLoading: false, isError: false, refetch: vi.fn() };
  state.slots = { data: { slots: [] }, isLoading: false };
  // Restored here rather than inside the tests that narrow them: a test that
  // fails partway through would otherwise leak its lookup lists into the next.
  state.clients = { data: { data: [{ id: 'c1', name: 'Asha Rao', phone: '+919800000001' }] } };
  state.services = { data: { data: [{ id: 'i1', name: 'Deep Tissue Massage' }] } };
  state.staff = { data: { staff: [{ id: 's1', name: 'Meera' }] } };
  state.settings = {
    data: { bookingEnabled: true, defaultSlotDurationMinutes: 30, officeHours: {} },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  flags.createError = false;
  flags.settingsError = false;
  role = 'STAFF';
  calendarRange = null;
  slotArgs = null;
  vi.clearAllMocks();
});

describe('BookingCalendar', () => {
  it('opens on the current week, Monday to Sunday', () => {
    render(<BookingCalendar onSelectBooking={vi.fn()} />);
    // The range is sent as a date-only string, which Date parses as UTC — read
    // the weekday in UTC too, or a timezone behind UTC shifts it a day.
    const from = new Date(calendarRange!.from);
    const to = new Date(calendarRange!.to);
    expect(from.getUTCDay()).toBe(1);
    expect(to.getUTCDay()).toBe(0);
    // Seven days inclusive.
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(6);
  });

  it('pads the month grid out to whole weeks', () => {
    render(<BookingCalendar onSelectBooking={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    const from = new Date(calendarRange!.from);
    const to = new Date(calendarRange!.to);
    expect(from.getUTCDay()).toBe(1);
    expect(to.getUTCDay()).toBe(0);
    const span = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    expect(span % 7).toBe(0);
  });

  it('steps a week at a time in week view and a month at a time in month view', () => {
    render(<BookingCalendar onSelectBooking={vi.fn()} />);
    const firstWeek = calendarRange!.from;
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const nextWeek = calendarRange!.from;
    expect(
      Math.round(
        (new Date(nextWeek).getTime() - new Date(firstWeek).getTime()) / 86_400_000,
      ),
    ).toBe(7);

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    const firstMonth = new Date(calendarRange!.from).getMonth();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(new Date(calendarRange!.from).getMonth()).not.toBe(firstMonth);
  });

  it('returns to the current week from Today', () => {
    render(<BookingCalendar onSelectBooking={vi.fn()} />);
    const original = calendarRange!.from;
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(calendarRange!.from).not.toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(calendarRange!.from).toBe(original);
  });

  it('files each event under its own day and opens the one clicked', () => {
    const onSelect = vi.fn();
    // Two events on the same day plus one the next day.
    const today = new Date();
    const iso = (d: Date) => d.toISOString();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    state.calendar.data = {
      events: [makeEvent('a', iso(today)), makeEvent('b', iso(tomorrow))],
    };
    render(<BookingCalendar onSelectBooking={onSelect} />);
    fireEvent.click(screen.getByText(/Booking a/));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows the loading and error states', () => {
    state.calendar = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    const { unmount } = render(<BookingCalendar onSelectBooking={vi.fn()} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    state.calendar = { data: undefined, isLoading: false, isError: true, refetch };
    render(<BookingCalendar onSelectBooking={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('CreateBookingModal', () => {
  function open() {
    const onClose = vi.fn();
    render(<CreateBookingModal open onClose={onClose} />);
    return onClose;
  }

  const submitButton = () => screen.getByRole('button', { name: 'Create booking' });

  it('renders nothing while closed', () => {
    const { container } = render(<CreateBookingModal open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('needs a client, a service and a time before it can submit', () => {
    open();
    expect(submitButton()).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByText('Asha Rao'));
    expect(submitButton()).toBeDisabled();

    const [service] = screen.getAllByRole('combobox');
    fireEvent.change(service, { target: { value: 'i1' } });
    expect(submitButton()).toBeDisabled();

    fireEvent.change(document.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-08-20T10:00' },
    });
    expect(submitButton()).toBeEnabled();
  });

  it('searches clients only once something is typed', () => {
    open();
    expect(screen.queryByText('Asha Rao')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'As' } });
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
  });

  it('says so when the search matches nobody', () => {
    state.clients = { data: { data: [] } };
    open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching clients.')).toBeInTheDocument();
  });

  it('lets the operator swap the chosen client back out', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByText('Asha Rao'));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByPlaceholderText(/Search client/)).toBeInTheDocument();
  });

  it('does not look for slots until a service is chosen', () => {
    open();
    expect(slotArgs![1]).toBe(false);
    expect(screen.getByText(/Choose a service to see suggested slots/)).toBeInTheDocument();

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });
    expect(slotArgs![1]).toBe(true);
    expect(slotArgs![0]).toMatchObject({ catalogItemId: 'i1' });
  });

  it('offers only the available slots and fills the time when one is picked', () => {
    state.slots.data = {
      slots: [
        { startTime: '2026-08-20T04:30:00.000Z', available: true },
        { startTime: '2026-08-20T05:30:00.000Z', available: false },
      ],
    };
    open();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });

    const chips = screen.getAllByRole('button').filter((b) => /\d{2}:\d{2}/.test(b.textContent ?? ''));
    expect(chips).toHaveLength(1);
    fireEvent.click(chips[0]);
    expect(document.querySelector('input[type="datetime-local"]')).not.toHaveValue('');
  });

  it('says so when the next fortnight has no open slot', () => {
    open();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });
    expect(screen.getByText(/No open slots in the next 14 days/)).toBeInTheDocument();
  });

  it('submits with the confirmation and order switches on by default', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByText('Asha Rao'));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-08-20T10:00' },
    });
    fireEvent.click(submitButton());

    expect(mutations.create).toHaveBeenCalledWith(
      {
        clientId: 'c1',
        catalogItemId: 'i1',
        staffMemberId: undefined,
        startTime: new Date('2026-08-20T10:00').toISOString(),
        notes: undefined,
        sendConfirmation: true,
        createOrder: true,
      },
      expect.anything(),
    );
  });

  it('passes the chosen staff member and trimmed notes through', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByText('Asha Rao'));
    const [service, staff] = screen.getAllByRole('combobox');
    fireEvent.change(service, { target: { value: 'i1' } });
    fireEvent.change(staff, { target: { value: 's1' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-08-20T10:00' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Anything the team should know/), {
      target: { value: '  Allergic to lavender  ' },
    });
    fireEvent.click(submitButton());

    const body = mutations.create.mock.calls[0][0];
    expect(body.staffMemberId).toBe('s1');
    expect(body.notes).toBe('Allergic to lavender');
  });

  it('clears the form when cancelled', () => {
    const onClose = open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Search client/)).toHaveValue('');
  });

  it('warns that a slot may have been taken when the create is refused', () => {
    flags.createError = true;
    open();
    expect(screen.getByText(/slot may no longer be available/)).toBeInTheDocument();
  });

  it('still renders every picker before any lookup list has arrived', () => {
    // The modal opens immediately while clients/services/staff/slots are all
    // still in flight; an unguarded read of any of them blanks the whole form.
    state.clients = { data: undefined };
    state.services = { data: undefined };
    state.staff = { data: undefined };
    state.slots = { data: undefined, isLoading: true };
    open();

    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'As' } });
    expect(screen.getByText('No matching clients.')).toBeInTheDocument();

    const [service, staff] = screen.getAllByRole('combobox');
    expect(within(service).getAllByRole('option')).toHaveLength(1);
    expect(within(staff).getAllByRole('option')).toHaveLength(1);
  });

  it('says it is still looking while availability loads, not that there is none', () => {
    state.slots = { data: undefined, isLoading: true };
    open();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });

    expect(screen.getByText('Finding availability…')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/No open slots in the next 14 days/)).not.toBeInTheDocument();
  });

  it('falls back to the email when a client record carries no phone', () => {
    state.clients = {
      data: { data: [{ id: 'c9', name: 'Vikram Nair', phone: null, email: 'vikram@example.in' }] },
    };
    open();
    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Vik' } });
    expect(screen.getByText('vikram@example.in')).toBeInTheDocument();
  });

  it('refuses a submit that is missing any one of the three required fields', () => {
    // The button is disabled, but a form still submits on Enter — the guard in
    // submit() is the thing that actually stops a half-filled booking.
    open();
    const form = document.querySelector('form') as HTMLFormElement;

    fireEvent.submit(form);
    expect(mutations.create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Search client/), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByText('Asha Rao'));
    fireEvent.submit(form);
    expect(mutations.create).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'i1' } });
    fireEvent.submit(form);
    expect(mutations.create).not.toHaveBeenCalled();

    fireEvent.change(document.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-08-20T10:00' },
    });
    fireEvent.submit(form);
    expect(mutations.create).toHaveBeenCalledTimes(1);
  });
});

describe('BookingDetailDrawer', () => {
  function open(overrides: Partial<Booking> = {}) {
    state.booking.data = makeBooking(overrides);
    const onClose = vi.fn();
    return { onClose, ...render(<BookingDetailDrawer bookingId="bk-1" onClose={onClose} />) };
  }

  it('shows a loading state when no booking is selected', () => {
    render(<BookingDetailDrawer bookingId={null} onClose={vi.fn()} />);
    expect(screen.queryByText('Deep Tissue Massage')).toBeNull();
  });

  it('renders the client, timings, price and payment state', () => {
    open({ paymentStatus: 'PAID' });
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('+919800000001')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(screen.getByText('₹1,500.00')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('falls back to dashes when the client record is missing', () => {
    open({ client: undefined });
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('offers Confirm only while pending or rescheduled', () => {
    const { unmount } = render(<BookingDetailDrawer bookingId="bk-1" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument();
    unmount();

    open({ status: 'CONFIRMED' });
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
  });

  it('confirms, completes and marks no-show through their own mutations', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    expect(mutations.update).toHaveBeenCalledWith({ id: 'bk-1', body: { status: 'CONFIRMED' } });

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(mutations.complete).toHaveBeenCalledWith({ id: 'bk-1' });

    fireEvent.click(screen.getByRole('button', { name: /No-show/ }));
    expect(mutations.update).toHaveBeenLastCalledWith({ id: 'bk-1', body: { status: 'NO_SHOW' } });
  });

  it('withdraws the action rail once the booking is terminal', () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as BookingStatus[]) {
      const { unmount } = open({ status });
      expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
      unmount();
    }
  });

  it('gives a VIEWER no write controls at all', () => {
    role = 'VIEWER';
    open();
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reschedule/ })).toBeNull();
    // The record itself stays readable.
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
  });

  it('prefills the reschedule modal with the current start time', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));
    const input = document.querySelector(
      'form#reschedule-form input[type="datetime-local"]',
    ) as HTMLInputElement;
    expect(input.value).not.toBe('');

    fireEvent.change(input, { target: { value: '2026-08-25T11:00' } });
    fireEvent.submit(document.querySelector('form#reschedule-form') as HTMLFormElement);
    expect(mutations.update).toHaveBeenCalledWith(
      { id: 'bk-1', body: { startTime: new Date('2026-08-25T11:00').toISOString() } },
      expect.anything(),
    );
  });

  it('cancels with an optional reason and no refund by default', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.submit(document.querySelector('form#cancel-booking-form') as HTMLFormElement);
    expect(mutations.cancel).toHaveBeenCalledWith(
      { id: 'bk-1', reason: undefined, refundPayment: false },
      expect.anything(),
    );
  });

  it('shuts the reschedule modal once the update lands', () => {
    mutations.update = vi.fn((_args, opts) => opts?.onSuccess?.());
    open();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));
    expect(screen.getByText('Reschedule booking')).toBeInTheDocument();

    fireEvent.submit(document.querySelector('form#reschedule-form') as HTMLFormElement);

    expect(screen.queryByText('Reschedule booking')).toBeNull();
  });

  it('shuts the cancel modal once the cancellation lands', () => {
    mutations.cancel = vi.fn((_args, opts) => opts?.onSuccess?.());
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Cancel booking', { selector: 'h2, h3' })).toBeInTheDocument();

    fireEvent.submit(document.querySelector('form#cancel-booking-form') as HTMLFormElement);

    expect(screen.queryByText('Cancel booking', { selector: 'h2, h3' })).toBeNull();
  });

  it('backs out of the reschedule modal without touching the booking', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));

    // Two "Cancel" buttons exist once the modal is up — the action rail's and
    // the modal footer's. The modal's is the one inside the dialog.
    const dialog = screen.getByText('Reschedule booking').closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Reschedule booking')).toBeNull();
    expect(mutations.update).not.toHaveBeenCalled();
  });

  it('keeps the booking when the cancel modal is dismissed', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Keep booking' }));

    expect(screen.queryByRole('button', { name: 'Keep booking' })).toBeNull();
    expect(mutations.cancel).not.toHaveBeenCalled();
  });

  it('refuses to reschedule to an empty time', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));
    const input = document.querySelector(
      'form#reschedule-form input[type="datetime-local"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });

    fireEvent.submit(document.querySelector('form#reschedule-form') as HTMLFormElement);

    expect(mutations.update).not.toHaveBeenCalled();
    // The submit button in the modal footer, not the action rail's opener.
    expect(document.querySelector('button[form="reschedule-form"]')).toBeDisabled();
  });

  // A refetch that 404s — the booking was deleted in another tab — empties the
  // query while a modal is still mounted. Both submits must no-op rather than
  // fire a mutation against `undefined.id`.
  it('cancels nothing if the booking disappears while the cancel modal is open', () => {
    const { rerender } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    state.booking.data = undefined;
    rerender(<BookingDetailDrawer bookingId="bk-1" onClose={vi.fn()} />);
    fireEvent.submit(document.querySelector('form#cancel-booking-form') as HTMLFormElement);

    expect(mutations.cancel).not.toHaveBeenCalled();
  });

  it('reschedules nothing if the booking disappears while the reschedule modal is open', () => {
    const { rerender } = open();
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));

    state.booking.data = undefined;
    rerender(<BookingDetailDrawer bookingId="bk-1" onClose={vi.fn()} />);
    fireEvent.submit(document.querySelector('form#reschedule-form') as HTMLFormElement);

    expect(mutations.update).not.toHaveBeenCalled();
  });

  it('offers a refund toggle only on a booking that was paid', () => {
    const { unmount } = open({ paymentStatus: 'UNPAID' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();

    open({ paymentStatus: 'PAID' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByPlaceholderText(/Why is this booking/), {
      target: { value: 'Client double-booked' },
    });
    fireEvent.submit(document.querySelector('form#cancel-booking-form') as HTMLFormElement);
    expect(mutations.cancel).toHaveBeenCalledWith(
      { id: 'bk-1', reason: 'Client double-booked', refundPayment: true },
      expect.anything(),
    );
  });

  it('shows the cancellation reason on an already-cancelled booking', () => {
    open({ status: 'CANCELLED', cancelReason: 'Client rescheduled offline' });
    expect(screen.getByText(/Cancelled: Client rescheduled offline/)).toBeInTheDocument();
  });

  it('renders internal and client notes separately', () => {
    open({ notes: 'Bring hot stones', clientNotes: 'Prefers quiet room' });
    expect(screen.getByText('Bring hot stones')).toBeInTheDocument();
    expect(screen.getByText('Prefers quiet room')).toBeInTheDocument();
  });

  it('retries a failed load', () => {
    const refetch = vi.fn();
    state.booking = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('nope'),
      refetch,
    };
    render(<BookingDetailDrawer bookingId="bk-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('AvailabilitySettings', () => {
  it('seeds the form from the stored settings', () => {
    state.settings.data = {
      bookingEnabled: false,
      defaultSlotDurationMinutes: 45,
      officeHours: {},
    };
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByDisplayValue('45')).toBeInTheDocument();
  });

  it('defaults the slot length when the business never set one', () => {
    state.settings.data = { bookingEnabled: true, officeHours: {} };
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('saves the toggle and the slot length as a number', () => {
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(mutations.updateSettings).toHaveBeenCalledWith(
      { bookingEnabled: false, defaultSlotDurationMinutes: 60, officeHours: {} },
      expect.anything(),
    );
  });

  it('falls back to 30 minutes rather than saving NaN', () => {
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(mutations.updateSettings.mock.calls[0][0].defaultSlotDurationMinutes).toBe(30);
  });

  it('closes once the save succeeds', () => {
    const onClose = vi.fn();
    render(<AvailabilitySettings open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    act(() => mutations.updateSettings.mock.calls[0][1].onSuccess());
    expect(onClose).toHaveBeenCalled();
  });

  it('cannot save while the settings are still loading or failed', () => {
    state.settings = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    const { unmount } = render(<AvailabilitySettings open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    unmount();

    const refetch = vi.fn();
    state.settings = { data: undefined, isLoading: false, isError: true, refetch };
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('reports a rejected save', () => {
    flags.settingsError = true;
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    expect(screen.getByText(/Couldn’t save settings/)).toBeInTheDocument();
  });

  it('renders the working-hours editor', () => {
    render(<AvailabilitySettings open onClose={vi.fn()} />);
    const section = screen.getByText('Working hours').parentElement as HTMLElement;
    expect(within(section).getByText(/Monday/i)).toBeInTheDocument();
  });
});
