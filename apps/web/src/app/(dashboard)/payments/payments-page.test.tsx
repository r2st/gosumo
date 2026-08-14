/**
 * The payments page — the ledger view over payments and the invoices derived
 * from them.
 *
 * Two things here are worth pinning. The filters must reach the API, because a
 * filter that is rendered but never sent shows the operator a full list while
 * telling them it is narrowed. And the Invoices tab is a client-side view over
 * the same fetch: only captured, partially-refunded and refunded payments are
 * invoiceable, so the tab must both drop the payment-only filters from the
 * request and filter the rows it shows — otherwise a pending payment appears
 * as a document that claims money already changed hands.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payment, PaymentStatus } from '@/lib/types';
import type { Role } from '@/lib/feature-types';

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'aaaaaaaa-bbbb-cccc',
    businessId: 'b1',
    clientId: 'c1',
    amount: 250_000,
    currency: 'INR',
    status: 'CAPTURED',
    method: 'UPI',
    refunds: [],
    metadata: {},
    createdAt: '2026-08-01T06:30:00.000Z',
    updatedAt: '2026-08-01T06:30:00.000Z',
    client: { id: 'c1', name: 'Asha Rao', phone: '+919800000001' },
    ...overrides,
  } as Payment;
}

const state = {
  payments: {
    data: { data: [makePayment()], total: 1 } as { data: Payment[]; total: number } | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
};

/** The filters the page last asked the payments endpoint for. */
let listArgs: Record<string, unknown> | null = null;
let role: Role = 'STAFF';

vi.mock('@/hooks/use-payments', () => ({
  usePayments: (args: Record<string, unknown>) => {
    listArgs = args;
    return state.payments;
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

// The three child surfaces have their own suite; here only their open/closed
// state matters, so they are stubbed down to what they were handed.
vi.mock('@/components/payments/revenue-summary', () => ({
  RevenueSummary: () => <div data-testid="revenue-summary" />,
}));
vi.mock('@/components/payments/create-payment-link-modal', () => ({
  CreatePaymentLinkModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="link-modal" /> : null,
}));
vi.mock('@/components/payments/payment-detail-drawer', () => ({
  PaymentDetailDrawer: ({ paymentId }: { paymentId: string | null }) =>
    paymentId ? <div data-testid="detail-drawer">{paymentId}</div> : null,
}));
vi.mock('@/components/payments/invoice-detail-drawer', () => ({
  InvoiceDetailDrawer: ({ payment }: { payment: Payment | null }) =>
    payment ? <div data-testid="invoice-drawer">{payment.id}</div> : null,
}));

import PaymentsPage from './page';

const invoicesTab = () => screen.getByRole('button', { name: 'Invoices' });

beforeEach(() => {
  state.payments = {
    data: { data: [makePayment()], total: 1 },
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  listArgs = null;
  role = 'STAFF';
  vi.clearAllMocks();
});

describe('PaymentsPage', () => {
  it('opens on the payments tab with the revenue summary above it', () => {
    render(<PaymentsPage />);
    expect(screen.getByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    expect(screen.getByTestId('revenue-summary')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Payment ID' })).toBeInTheDocument();
  });

  it('asks for a full page of payments and no filters by default', () => {
    render(<PaymentsPage />);
    expect(listArgs).toEqual({ status: undefined, method: undefined, limit: 100 });
  });

  it('sends the chosen status and method to the API', () => {
    render(<PaymentsPage />);
    const [status, method] = screen.getAllByRole('combobox');
    fireEvent.change(status, { target: { value: 'CAPTURED' } });
    fireEvent.change(method, { target: { value: 'UPI' } });
    expect(listArgs).toEqual({ status: 'CAPTURED', method: 'UPI', limit: 100 });
  });

  it('offers every payment status and method as a filter', () => {
    render(<PaymentsPage />);
    const [status, method] = screen.getAllByRole('combobox');
    expect(within(status).getAllByRole('option')).toHaveLength(8);
    expect(within(method).getAllByRole('option')).toHaveLength(7);
    expect(within(status).getByRole('option', { name: 'Partially Refunded' })).toBeInTheDocument();
  });

  it('shows a table skeleton while the first page loads', () => {
    state.payments = { ...state.payments, data: undefined, isLoading: true };
    render(<PaymentsPage />);
    expect(screen.getByText('Loading payments…')).toBeInTheDocument();
  });

  it('offers a retry when the list fails', () => {
    const refetch = vi.fn();
    state.payments = { data: undefined, isLoading: false, isError: true, error: new Error('x'), refetch };
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('says so when there is nothing to show', () => {
    state.payments = { ...state.payments, data: { data: [], total: 0 } };
    render(<PaymentsPage />);
    expect(screen.getByText('No payments found')).toBeInTheDocument();
  });

  it('survives a response body that never arrived', () => {
    state.payments = { ...state.payments, data: undefined, isLoading: false };
    render(<PaymentsPage />);
    expect(screen.getByText('No payments found')).toBeInTheDocument();
  });

  it('renders a payment row: truncated id, client, amount, method and time', () => {
    render(<PaymentsPage />);
    expect(screen.getByText('aaaaaaaa…')).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('₹2,500.00')).toBeInTheDocument();
    expect(screen.getByText(/1 Aug 2026/)).toBeInTheDocument();
    // "Upi" is also a filter option, so read the badge out of the row itself.
    const row = screen.getByText('Asha Rao').closest('tr')!;
    expect(within(row).getByText('Upi')).toBeInTheDocument();
  });

  it('dashes the client and the method when the payment has neither', () => {
    state.payments = {
      ...state.payments,
      data: { data: [makePayment({ client: undefined, method: undefined })], total: 1 },
    };
    render(<PaymentsPage />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('links out to the payment link, preferring the short form', () => {
    state.payments = {
      ...state.payments,
      data: {
        data: [
          makePayment({
            paymentLinkUrl: 'https://rzp.io/i/long',
            paymentLinkShortUrl: 'https://rzp.io/i/s',
          }),
        ],
        total: 1,
      },
    };
    render(<PaymentsPage />);
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute('href', 'https://rzp.io/i/s');
  });

  it('opens the detail drawer for the clicked payment', () => {
    render(<PaymentsPage />);
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Asha Rao'));
    expect(screen.getByTestId('detail-drawer')).toHaveTextContent('aaaaaaaa-bbbb-cccc');
  });

  it('does not open the drawer when the link in the row is clicked', () => {
    state.payments = {
      ...state.payments,
      data: { data: [makePayment({ paymentLinkUrl: 'https://rzp.io/i/long' })], total: 1 },
    };
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole('link', { name: /open/i }));
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
  });

  describe('the payment-link action', () => {
    it('opens the modal for an operator who can write', () => {
      render(<PaymentsPage />);
      fireEvent.click(screen.getByRole('button', { name: /payment link/i }));
      expect(screen.getByTestId('link-modal')).toBeInTheDocument();
    });

    it('is not offered to a VIEWER', () => {
      role = 'VIEWER';
      render(<PaymentsPage />);
      expect(screen.queryByRole('button', { name: /payment link/i })).not.toBeInTheDocument();
    });
  });

  describe('the invoices tab', () => {
    const mixed = [
      makePayment({ id: 'p-captured', status: 'CAPTURED' }),
      makePayment({ id: 'p-partial', status: 'PARTIALLY_REFUNDED' }),
      makePayment({ id: 'p-refunded', status: 'REFUNDED' }),
      makePayment({ id: 'p-pending', status: 'PENDING' }),
      makePayment({ id: 'p-failed', status: 'FAILED' }),
      makePayment({ id: 'p-expired', status: 'EXPIRED' }),
    ];

    it('swaps in the invoice columns', () => {
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      expect(screen.getByRole('columnheader', { name: 'Invoice' })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Payment ID' })).not.toBeInTheDocument();
    });

    it('hides the payment filters and stops sending them', () => {
      render(<PaymentsPage />);
      const [status] = screen.getAllByRole('combobox');
      fireEvent.change(status, { target: { value: 'CAPTURED' } });
      fireEvent.click(invoicesTab());

      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(listArgs).toEqual({ status: undefined, method: undefined, limit: 100 });
    });

    it('lists only the payments that money actually moved through', () => {
      state.payments = { ...state.payments, data: { data: mixed, total: mixed.length } };
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      expect(screen.getAllByRole('row')).toHaveLength(4); // header + three invoiceable
      expect(screen.queryByText(/INV-2026-P-PENDIN/)).not.toBeInTheDocument();
    });

    it('numbers each invoice from the payment year and id', () => {
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      expect(screen.getByText('INV-2026-AAAAAAAA')).toBeInTheDocument();
    });

    it('dates an invoice from the capture when there is one', () => {
      state.payments = {
        ...state.payments,
        data: {
          data: [makePayment({ capturedAt: '2026-08-05T06:30:00.000Z' })],
          total: 1,
        },
      };
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      expect(screen.getByText('5 Aug 2026')).toBeInTheDocument();
    });

    it('says so when nothing has been captured yet', () => {
      state.payments = {
        ...state.payments,
        data: { data: [makePayment({ status: 'PENDING' })], total: 1 },
      };
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      expect(screen.getByText('No invoices yet')).toBeInTheDocument();
    });

    it('labels the skeleton for invoices while loading', () => {
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      state.payments = { ...state.payments, data: undefined, isLoading: true };
      render(<PaymentsPage />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Invoices' })[1]);
      expect(screen.getByText('Loading invoices…')).toBeInTheDocument();
    });

    it('opens the invoice document for the clicked row', () => {
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      fireEvent.click(screen.getByText('INV-2026-AAAAAAAA'));
      expect(screen.getByTestId('invoice-drawer')).toHaveTextContent('aaaaaaaa-bbbb-cccc');
    });

    it.each(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as PaymentStatus[])(
      'treats a %s payment as an invoice',
      (status) => {
        state.payments = { ...state.payments, data: { data: [makePayment({ status })], total: 1 } };
        render(<PaymentsPage />);
        fireEvent.click(invoicesTab());
        expect(screen.getByText('INV-2026-AAAAAAAA')).toBeInTheDocument();
      },
    );

    it('goes back to the payments list', () => {
      render(<PaymentsPage />);
      fireEvent.click(invoicesTab());
      fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
      expect(screen.getByRole('columnheader', { name: 'Payment ID' })).toBeInTheDocument();
    });
  });
});
