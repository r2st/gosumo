/**
 * The site-visits page: list/calendar switching, the row action rail, and the
 * three modals that write.
 *
 * The interesting logic here is not the markup — it is the upcoming/past split
 * (a visit is "upcoming" only if it is both in the future AND not terminal, so
 * a cancelled visit next week belongs in the past column) and the write gating,
 * which hides the entire action rail from a VIEWER. Both are easy to invert by
 * accident and neither shows up in a type error.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteVisit } from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

const HOUR = 60 * 60 * 1000;
const future = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const past = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function makeVisit(overrides: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v1',
    businessId: 'b1',
    leadId: 'lead-abcdef12',
    projectId: 'p1',
    unitId: null,
    assignedAgentId: null,
    scheduledAt: future(24),
    durationMinutes: 45,
    timezone: 'Asia/Kolkata',
    status: 'BOOKED',
    bookingId: null,
    calendarEventId: null,
    calendarId: null,
    reminderState: {},
    remindersSent: 0,
    lastReminderAt: null,
    feedback: null,
    outcome: 'PENDING',
    rescheduledFrom: null,
    cancellationReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

let visits: SiteVisit[] = [];
let visitsState = { isLoading: false, isError: false };
let role: Role = 'STAFF';

const refetch = vi.fn();
const mutations = {
  book: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  noShow: vi.fn(),
  reschedule: vi.fn(),
};

const asMutation = (mutate: ReturnType<typeof vi.fn>) => ({
  mutate,
  isPending: false,
  isError: false,
});

vi.mock('@/hooks/use-realty', () => ({
  useSiteVisits: () => ({
    data: { data: visits },
    isLoading: visitsState.isLoading,
    isError: visitsState.isError,
    error: visitsState.isError ? new Error('boom') : undefined,
    refetch,
  }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'Prestige Lakeside', locality: 'Whitefield' }] }),
  useLeads: () => ({
    data: { data: [{ id: 'lead-abcdef12', name: 'Asha Rao', whatsappPhone: '+919800000001' }] },
  }),
  useBookVisit: () => asMutation(mutations.book),
  useConfirmVisit: () => asMutation(mutations.confirm),
  useCancelVisit: () => asMutation(mutations.cancel),
  useCompleteVisit: () => asMutation(mutations.complete),
  useMarkNoShow: () => asMutation(mutations.noShow),
  useRescheduleVisit: () => asMutation(mutations.reschedule),
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

import SiteVisitsPage from './page';

beforeEach(() => {
  visits = [makeVisit()];
  visitsState = { isLoading: false, isError: false };
  role = 'STAFF';
  vi.clearAllMocks();
});

describe('SiteVisitsPage states', () => {
  it('shows the loading state while the query is in flight', () => {
    visitsState = { isLoading: true, isError: false };
    render(<SiteVisitsPage />);
    expect(screen.getByText('Loading visits…')).toBeInTheDocument();
  });

  it('offers a retry when the query failed', () => {
    visitsState = { isLoading: false, isError: true };
    render(<SiteVisitsPage />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state when there are no visits', () => {
    visits = [];
    render(<SiteVisitsPage />);
    expect(screen.getByText('No site visits yet')).toBeInTheDocument();
  });
});

describe('SiteVisitsPage upcoming/past split', () => {
  it('files a future non-terminal visit under Upcoming', () => {
    visits = [makeVisit({ id: 'v1', scheduledAt: future(24), status: 'BOOKED' })];
    render(<SiteVisitsPage />);
    expect(screen.getByText('No past visits.')).toBeInTheDocument();
    expect(screen.queryByText('No upcoming visits.')).toBeNull();
  });

  it('files a future CANCELLED visit under Past, not Upcoming', () => {
    visits = [makeVisit({ id: 'v1', scheduledAt: future(24), status: 'CANCELLED' })];
    render(<SiteVisitsPage />);
    expect(screen.getByText('No upcoming visits.')).toBeInTheDocument();
    expect(screen.queryByText('No past visits.')).toBeNull();
  });

  it('files an elapsed visit under Past even while still BOOKED', () => {
    visits = [makeVisit({ id: 'v1', scheduledAt: past(4), status: 'BOOKED' })];
    render(<SiteVisitsPage />);
    expect(screen.getByText('No upcoming visits.')).toBeInTheDocument();
  });

  it('renders the outcome and feedback once a visit is completed', () => {
    visits = [
      makeVisit({
        id: 'v1',
        scheduledAt: past(4),
        status: 'COMPLETED',
        outcome: 'TOKEN_BOOKED',
        feedback: 'Loved the clubhouse',
      }),
    ];
    render(<SiteVisitsPage />);
    expect(screen.getByText(/Token booked/)).toBeInTheDocument();
    expect(screen.getByText(/Loved the clubhouse/)).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });
});

describe('SiteVisitsPage row actions', () => {
  it('fires the confirm, no-show and cancel mutations with the visit id', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mutations.confirm).toHaveBeenCalledWith('v1');

    fireEvent.click(screen.getByRole('button', { name: 'No-show' }));
    expect(mutations.noShow).toHaveBeenCalledWith('v1');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutations.cancel).toHaveBeenCalledWith({ id: 'v1' });
  });

  it('hides Confirm once the visit is already confirmed', () => {
    visits = [makeVisit({ status: 'CONFIRMED' })];
    render(<SiteVisitsPage />);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
  });

  it('offers no actions on a terminal visit', () => {
    visits = [makeVisit({ status: 'COMPLETED', scheduledAt: past(4) })];
    render(<SiteVisitsPage />);
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
  });

  it('gives a VIEWER neither the action rail nor the Book visit button', () => {
    role = 'VIEWER';
    render(<SiteVisitsPage />);
    expect(screen.queryByRole('button', { name: /Book visit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});

describe('SiteVisitsPage reschedule modal', () => {
  it('keeps Reschedule disabled until a date is picked, then sends UTC', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));

    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Reschedule' });
    expect(submit).toBeDisabled();

    const input = dialog.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-09-01T10:30' } });
    fireEvent.click(submit);

    expect(mutations.reschedule).toHaveBeenCalledWith(
      { id: 'v1', newScheduledAt: new Date('2026-09-01T10:30').toISOString() },
      expect.anything(),
    );
  });

  it('closes without writing when Cancel is pressed', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mutations.reschedule).not.toHaveBeenCalled();
  });
});

describe('SiteVisitsPage complete modal', () => {
  it('defaults to INTERESTED and omits empty feedback', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save outcome' }));

    expect(mutations.complete).toHaveBeenCalledWith(
      { id: 'v1', outcome: 'INTERESTED', feedback: undefined },
      expect.anything(),
    );
  });

  it('never offers PENDING as a settable outcome', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    const select = screen.getByRole('dialog').querySelector('select') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).not.toContain('Pending');
    expect(labels).toContain('Token booked');
  });

  it('sends the chosen outcome and typed feedback', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(dialog.querySelector('select') as HTMLSelectElement, {
      target: { value: 'NOT_INTERESTED' },
    });
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'Too far from school' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save outcome' }));

    expect(mutations.complete).toHaveBeenCalledWith(
      { id: 'v1', outcome: 'NOT_INTERESTED', feedback: 'Too far from school' },
      expect.anything(),
    );
  });
});

describe('SiteVisitsPage book modal', () => {
  function openBooking() {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Book visit/ }));
    return screen.getByRole('dialog');
  }

  it('keeps submit disabled until lead, project and time are all chosen', () => {
    const dialog = openBooking();
    const submit = within(dialog).getByRole('button', { name: 'Book visit' });
    expect(submit).toBeDisabled();

    const [leadSelect, projectSelect] = Array.from(dialog.querySelectorAll('select'));
    fireEvent.change(leadSelect, { target: { value: 'lead-abcdef12' } });
    expect(submit).toBeDisabled();

    fireEvent.change(projectSelect, { target: { value: 'p1' } });
    expect(submit).toBeDisabled();

    fireEvent.change(dialog.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-09-01T11:00' },
    });
    expect(submit).toBeEnabled();
  });

  it('books with the duration and notes, converting local time to UTC', () => {
    const dialog = openBooking();
    const [leadSelect, projectSelect] = Array.from(dialog.querySelectorAll('select'));
    fireEvent.change(leadSelect, { target: { value: 'lead-abcdef12' } });
    fireEvent.change(projectSelect, { target: { value: 'p1' } });
    fireEvent.change(dialog.querySelector('input[type="datetime-local"]') as HTMLInputElement, {
      target: { value: '2026-09-01T11:00' },
    });
    fireEvent.change(dialog.querySelector('input[type="number"]') as HTMLInputElement, {
      target: { value: '90' },
    });
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'Meet at gate 2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book visit' }));

    expect(mutations.book).toHaveBeenCalledWith(
      {
        leadId: 'lead-abcdef12',
        projectId: 'p1',
        scheduledAt: new Date('2026-09-01T11:00').toISOString(),
        durationMinutes: 90,
        notes: 'Meet at gate 2',
      },
      expect.anything(),
    );
  });

  it('lists each lead with its phone and each project with its locality', () => {
    const dialog = openBooking();
    const [leadSelect, projectSelect] = Array.from(dialog.querySelectorAll('select'));
    expect(Array.from(leadSelect.options).map((o) => o.textContent)).toContain(
      'Asha Rao · +919800000001',
    );
    expect(Array.from(projectSelect.options).map((o) => o.textContent)).toContain(
      'Prestige Lakeside · Whitefield',
    );
  });
});

describe('SiteVisitsPage calendar view', () => {
  it('switches to a month grid with the weekday header', () => {
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(screen.getByText('Sun')).toBeInTheDocument();
    expect(screen.getByText('Sat')).toBeInTheDocument();
  });

  it('caps a busy day at three chips and counts the rest', () => {
    // Five visits in one hour of the current month — the grid only renders
    // cells for this month, so the day has to be picked inside it rather than
    // as "tomorrow", which falls out of the grid on the 31st.
    const now = new Date();
    const when = new Date(now.getFullYear(), now.getMonth(), 15, 11, 0).toISOString();
    visits = Array.from({ length: 5 }, (_, i) =>
      makeVisit({ id: `v${i}`, scheduledAt: when, leadId: `lead${i}0000` }),
    );
    render(<SiteVisitsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });
});
