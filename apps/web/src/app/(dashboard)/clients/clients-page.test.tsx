/**
 * ClientsPage — the contact-management list.
 *
 * Covers the four load states, the segment chips (which are the only way an
 * operator narrows to at-risk/new/returning), search, and the money column.
 * The money assertions matter disproportionately: the API sends lifetime spend
 * as `totalSpentPaise`, and the page previously read a `totalSpent` field that
 * the API has never sent, so every client showed ₹0.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@/lib/types';
import type { ClientFilters } from '@/lib/api-client';

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'cl1',
    businessId: 'b1',
    name: 'Priya Sharma',
    phone: '+919999900001',
    email: 'priya@example.in',
    avatarUrl: null,
    profile: {},
    optOuts: {},
    totalOrders: 3,
    totalSpentPaise: 1_050_000,
    lastInteractionAt: '2026-08-10T04:00:00.000Z',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-10T04:00:00.000Z',
    ...overrides,
  } as Client;
}

const state = {
  clients: {
    data: {
      data: [makeClient()] as Client[],
      pagination: { total: 1, limit: 50, page: 1, totalPages: 1, hasMore: false },
    } as { data: Client[]; pagination: Record<string, unknown> } | undefined,
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
};

/** Every filter object the page has asked for, in call order. */
let filterCalls: ClientFilters[] = [];

vi.mock('@/hooks/use-queries', () => ({
  useClients: (filters: ClientFilters) => {
    filterCalls.push(filters);
    return state.clients;
  },
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: ClientsPage } = await import('./page');

beforeEach(() => {
  filterCalls = [];
  state.clients = {
    data: {
      data: [makeClient()],
      pagination: { total: 1, limit: 50, page: 1, totalPages: 1, hasMore: false },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ClientsPage — load states', () => {
  it('shows a loading state while clients resolve', () => {
    state.clients.isLoading = true;
    render(<ClientsPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the error message and retries on demand', () => {
    state.clients.isError = true;
    state.clients.error = new Error('Upstream unavailable');
    render(<ClientsPage />);

    expect(screen.getByText('Upstream unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.clients.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when the segment matches nobody', () => {
    state.clients.data = {
      data: [],
      pagination: { total: 0, limit: 50, page: 1, totalPages: 1, hasMore: false },
    };
    render(<ClientsPage />);
    expect(screen.getByText('No clients found')).toBeInTheDocument();
  });

  it('treats a missing payload as empty rather than crashing on data.data', () => {
    state.clients.data = undefined;
    render(<ClientsPage />);
    expect(screen.getByText('No clients found')).toBeInTheDocument();
  });
});

describe('ClientsPage — client rows', () => {
  it('renders lifetime spend converted from paise, not the raw integer', () => {
    render(<ClientsPage />);
    // 1_050_000 paise = ₹10,500. Rendering the paise value directly would
    // read "₹10,50,000" — a 100× overstatement of what the client paid.
    expect(screen.getByText('₹10,500.00')).toBeInTheDocument();
    expect(screen.queryByText(/₹10,50,000/)).not.toBeInTheDocument();
  });

  it('renders ₹0.00 when the client has never spent anything', () => {
    state.clients.data = {
      data: [makeClient({ totalSpentPaise: 0, totalOrders: 0 })],
      pagination: { total: 1, limit: 50, page: 1, totalPages: 1, hasMore: false },
    };
    render(<ClientsPage />);
    expect(screen.getByText('₹0.00')).toBeInTheDocument();
  });

  it('links each row through to the client detail page', () => {
    render(<ClientsPage />);
    expect(screen.getByRole('link', { name: /Priya Sharma/ })).toHaveAttribute(
      'href',
      '/clients/cl1',
    );
  });

  it('falls back to "Unknown" and an em dash when name and contacts are absent', () => {
    state.clients.data = {
      data: [makeClient({ name: null, phone: null, email: null })],
      pagination: { total: 1, limit: 50, page: 1, totalPages: 1, hasMore: false },
    };
    render(<ClientsPage />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('prefers phone over email as the row subtitle', () => {
    render(<ClientsPage />);
    expect(screen.getByText('+919999900001')).toBeInTheDocument();
    expect(screen.queryByText('priya@example.in')).not.toBeInTheDocument();
  });

  it('falls back to email when the client has no phone', () => {
    state.clients.data = {
      data: [makeClient({ phone: null })],
      pagination: { total: 1, limit: 50, page: 1, totalPages: 1, hasMore: false },
    };
    render(<ClientsPage />);
    expect(screen.getByText('priya@example.in')).toBeInTheDocument();
  });
});

describe('ClientsPage — segments and search', () => {
  it('requests no extra filters on the default "All clients" segment', () => {
    render(<ClientsPage />);
    expect(filterCalls[0]).toEqual({ q: undefined, limit: 50 });
  });

  it('sends churnRiskLevel=HIGH when the at-risk segment is picked', () => {
    render(<ClientsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'At-risk' }));

    expect(filterCalls.at(-1)).toMatchObject({ churnRiskLevel: 'HIGH' });
  });

  it('distinguishes new (hasOrders false) from returning (hasOrders true)', () => {
    render(<ClientsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(filterCalls.at(-1)).toMatchObject({ hasOrders: false });

    fireEvent.click(screen.getByRole('button', { name: 'Returning' }));
    expect(filterCalls.at(-1)).toMatchObject({ hasOrders: true });
  });

  it('passes the search box through as `q`, and omits it when blank', () => {
    render(<ClientsPage />);
    const box = screen.getByPlaceholderText(/Search name, phone, email/);

    fireEvent.change(box, { target: { value: 'priya' } });
    expect(filterCalls.at(-1)).toMatchObject({ q: 'priya' });

    fireEvent.change(box, { target: { value: '' } });
    expect(filterCalls.at(-1)).toMatchObject({ q: undefined });
  });

  it('keeps the segment filter while searching within it', () => {
    render(<ClientsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'At-risk' }));
    fireEvent.change(screen.getByPlaceholderText(/Search name, phone, email/), {
      target: { value: 'priya' },
    });

    expect(filterCalls.at(-1)).toMatchObject({ churnRiskLevel: 'HIGH', q: 'priya' });
  });

  it('names the active segment in the result count, but not for "all"', () => {
    render(<ClientsPage />);
    expect(screen.getByText(/Showing 1 of 1 clients/)).toBeInTheDocument();
    expect(screen.queryByText('All clients', { selector: 'span' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'At-risk' }));
    expect(screen.getByText('At-risk', { selector: 'span' })).toBeInTheDocument();
  });

  it('hides the result count entirely when the query has no payload', () => {
    state.clients.data = undefined;
    render(<ClientsPage />);
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});
