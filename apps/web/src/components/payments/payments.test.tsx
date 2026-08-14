/**
 * The four payment components: the revenue summary, the payment-link modal,
 * the payment detail drawer and the invoice document.
 *
 * This is the surface where a mistake moves real money, so the tests pin the
 * arithmetic and the gates rather than the layout. Rupees typed into a form
 * must reach the API as integer paise; the refund ceiling must be the amount
 * captured minus everything already refunded — counting refunds that are still
 * PENDING, because that money is already on its way out — and neither Capture
 * nor Refund may exist for an operator who cannot write. The link modal holds
 * a live Razorpay URL, so the copy affordance is covered too: a copy that
 * silently fails leaves the operator sending nothing to the client.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Payment, PaymentRefund, PaymentStatus } from '@/lib/types';
import type { PaymentStats, PaymentLinkResponse } from '@/lib/commerce-types';
import type { Role } from '@/lib/feature-types';

function makeRefund(overrides: Partial<PaymentRefund> = {}): PaymentRefund {
  return {
    id: 'rf-1',
    paymentId: 'pay-1',
    amount: 50_000,
    reason: 'Damaged on arrival',
    status: 'PROCESSED',
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-11111111-2222',
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
  payment: {
    data: makePayment() as Payment | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
  stats: {
    data: {
      totalRevenue: 12_50_00_000,
      totalTransactions: 412,
      successRate: 0.937,
      avgTransactionValue: 303_398,
      refundedAmount: 45_00_000,
      refundCount: 12,
      methodBreakdown: {},
    } as PaymentStats | undefined,
    isLoading: false,
  },
  clients: {
    data: {
      data: [
        { id: 'c1', name: 'Asha Rao', phone: '+919800000001' },
        { id: 'c2', name: 'Bhavin Shah', email: 'bhavin@example.com' },
      ],
    } as { data: Array<Record<string, unknown>> } | undefined,
  },
  order: {
    data: undefined as Record<string, unknown> | undefined,
    isLoading: false,
  },
  business: { data: undefined as Record<string, unknown> | undefined },
};

const mutations = {
  createLink: vi.fn(),
  refund: vi.fn(),
  capture: vi.fn(),
};
const flags = { createError: false, refundError: false, createPending: false, refundPending: false };
let role: Role = 'STAFF';

/** The filters the client picker last asked the API for. */
let clientQueryArgs: Record<string, unknown> | null = null;

vi.mock('@/hooks/use-payments', () => ({
  usePayment: () => state.payment,
  usePaymentStats: () => state.stats,
  useCreatePaymentLink: () => ({
    mutate: mutations.createLink,
    isPending: flags.createPending,
    isError: flags.createError,
  }),
  useRefundPayment: () => ({
    mutate: mutations.refund,
    isPending: flags.refundPending,
    isError: flags.refundError,
  }),
  useCapturePayment: () => ({ mutate: mutations.capture, isPending: false, isError: false }),
}));

vi.mock('@/hooks/use-queries', () => ({
  useClients: (args: Record<string, unknown>) => {
    clientQueryArgs = args;
    return state.clients;
  },
}));

vi.mock('@/hooks/use-orders', () => ({ useOrder: () => state.order }));
vi.mock('@/hooks/use-settings', () => ({ useBusinessProfile: () => state.business }));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import { RevenueSummary } from './revenue-summary';
import { CreatePaymentLinkModal } from './create-payment-link-modal';
import { PaymentDetailDrawer } from './payment-detail-drawer';
import { InvoiceDetailDrawer } from './invoice-detail-drawer';

beforeEach(() => {
  state.payment = {
    data: makePayment(),
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  state.stats = {
    data: {
      totalRevenue: 12_50_00_000,
      totalTransactions: 412,
      successRate: 0.937,
      avgTransactionValue: 303_398,
      refundedAmount: 45_00_000,
      refundCount: 12,
      methodBreakdown: {},
    },
    isLoading: false,
  };
  state.clients = {
    data: {
      data: [
        { id: 'c1', name: 'Asha Rao', phone: '+919800000001' },
        { id: 'c2', name: 'Bhavin Shah', email: 'bhavin@example.com' },
      ],
    },
  };
  state.order = { data: undefined, isLoading: false };
  state.business = { data: undefined };
  flags.createError = false;
  flags.refundError = false;
  flags.createPending = false;
  flags.refundPending = false;
  role = 'STAFF';
  clientQueryArgs = null;
  vi.clearAllMocks();
});

// ── RevenueSummary ───────────────────────────────────────────────────────────

describe('RevenueSummary', () => {
  it('shows four placeholders while the stats load', () => {
    state.stats = { data: undefined, isLoading: true };
    const { container } = render(<RevenueSummary />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(4);
    expect(screen.queryByText('Total revenue')).not.toBeInTheDocument();
  });

  it('renders nothing at all when the stats endpoint returns no body', () => {
    state.stats = { data: undefined, isLoading: false };
    const { container } = render(<RevenueSummary />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders revenue compactly and the average transaction in full rupees', () => {
    render(<RevenueSummary />);
    // 12,50,00,000 paise = ₹12,50,000 = ₹12.50L.
    expect(screen.getByText('₹12.50L')).toBeInTheDocument();
    expect(screen.getByText('₹3,033.98')).toBeInTheDocument();
    expect(screen.getByText('₹45.0K')).toBeInTheDocument();
  });

  it('scales a 0–1 success ratio into a percentage', () => {
    render(<RevenueSummary />);
    expect(screen.getByText('93.7%')).toBeInTheDocument();
  });

  it('captions the revenue and refund cards with their counts', () => {
    render(<RevenueSummary />);
    expect(screen.getByText('412 transactions')).toBeInTheDocument();
    expect(screen.getByText('12 refunds')).toBeInTheDocument();
  });
});

// ── CreatePaymentLinkModal ───────────────────────────────────────────────────

describe('CreatePaymentLinkModal', () => {
  const amountInput = () => screen.getByRole('spinbutton');
  const descriptionInput = () => screen.getByPlaceholderText('What is this payment for?');
  const searchInput = () => screen.getByPlaceholderText('Search client by name, phone…');

  function selectClient(name = 'Asha Rao') {
    fireEvent.change(searchInput(), { target: { value: 'as' } });
    fireEvent.click(screen.getByText(name));
  }

  it('renders nothing while closed', () => {
    const { container } = render(<CreatePaymentLinkModal open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the client results until something is typed', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    expect(screen.queryByText('Asha Rao')).not.toBeInTheDocument();
    fireEvent.change(searchInput(), { target: { value: 'as' } });
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
  });

  it('passes the typed query to the client search, capped at six results', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    fireEvent.change(searchInput(), { target: { value: 'bhav' } });
    expect(clientQueryArgs).toEqual({ q: 'bhav', limit: 6 });
  });

  it('sends no query at all when the box is empty', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    expect(clientQueryArgs).toEqual({ q: undefined, limit: 6 });
  });

  it('says so when the search matches no client', () => {
    state.clients = { data: { data: [] } };
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    fireEvent.change(searchInput(), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching clients.')).toBeInTheDocument();
  });

  it('survives a client search that has not resolved yet', () => {
    state.clients = { data: undefined };
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    fireEvent.change(searchInput(), { target: { value: 'as' } });
    expect(screen.getByText('No matching clients.')).toBeInTheDocument();
  });

  it('falls back to the email when a client has no phone', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    fireEvent.change(searchInput(), { target: { value: 'b' } });
    expect(screen.getByText('bhavin@example.com')).toBeInTheDocument();
  });

  it('replaces the picker with the chosen client, and Change puts it back', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    selectClient();
    expect(screen.queryByPlaceholderText('Search client by name, phone…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Change'));
    expect(screen.getByPlaceholderText('Search client by name, phone…')).toBeInTheDocument();
  });

  it('keeps Create disabled until a client, an amount and a description are all present', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    const create = screen.getByRole('button', { name: /create link/i });
    expect(create).toBeDisabled();

    selectClient();
    expect(create).toBeDisabled();

    fireEvent.change(amountInput(), { target: { value: '1499.50' } });
    expect(create).toBeDisabled();

    fireEvent.change(descriptionInput(), { target: { value: 'Consultation' } });
    expect(create).toBeEnabled();
  });

  it('treats a whitespace-only description as missing', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    selectClient();
    fireEvent.change(amountInput(), { target: { value: '100' } });
    fireEvent.change(descriptionInput(), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /create link/i })).toBeDisabled();
  });

  it('converts the rupee amount to integer paise and trims the description', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    selectClient();
    fireEvent.change(amountInput(), { target: { value: '1499.50' } });
    fireEvent.change(descriptionInput(), { target: { value: '  Consultation  ' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));

    expect(mutations.createLink).toHaveBeenCalledTimes(1);
    expect(mutations.createLink.mock.calls[0][0]).toEqual({
      clientId: 'c1',
      amount: 149_950,
      description: 'Consultation',
      expiresInHours: 24,
      sendToClient: true,
      acceptPartialPayments: false,
    });
  });

  it('refuses an amount finer than a paisa instead of silently rounding it', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    selectClient();
    fireEvent.change(amountInput(), { target: { value: '10.999' } });
    fireEvent.change(descriptionInput(), { target: { value: 'Rounding' } });
    // step="0.01" makes the field out-of-range, so the browser blocks the
    // submit. Without it `Math.round(10.999 * 100)` would quietly bill ₹11.
    expect(amountInput()).toBeInvalid();
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    expect(mutations.createLink).not.toHaveBeenCalled();
  });

  it('carries the chosen expiry and both switches through to the request', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    selectClient();
    fireEvent.change(amountInput(), { target: { value: '500' } });
    fireEvent.change(descriptionInput(), { target: { value: 'Deposit' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '72' } });

    const [sendSwitch, partialSwitch] = screen.getAllByRole('switch');
    fireEvent.click(sendSwitch);
    fireEvent.click(partialSwitch);
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));

    expect(mutations.createLink.mock.calls[0][0]).toMatchObject({
      amount: 50_000,
      expiresInHours: 72,
      sendToClient: false,
      acceptPartialPayments: true,
    });
  });

  it('does not fire the mutation when the form is submitted incomplete', () => {
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    fireEvent.submit(document.getElementById('link-form')!);
    expect(mutations.createLink).not.toHaveBeenCalled();
  });

  it('surfaces a failed creation without closing the form', () => {
    flags.createError = true;
    render(<CreatePaymentLinkModal open onClose={vi.fn()} />);
    expect(screen.getByText(/couldn’t create the payment link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create link/i })).toBeInTheDocument();
  });

  describe('once the link exists', () => {
    const linkResult: PaymentLinkResponse = {
      payment: makePayment({ amount: 149_950, status: 'PENDING' }),
      link: {
        id: 'plink_1',
        url: 'https://rzp.io/i/full-length-link',
        shortUrl: 'https://rzp.io/i/abc',
        expiresAt: '2026-08-02T06:30:00.000Z',
      },
      messageSent: true,
    };

    /** Create a link and hand back the `onSuccess` the component registered. */
    function createLink(result: PaymentLinkResponse = linkResult, onClose = vi.fn()) {
      const view = render(<CreatePaymentLinkModal open onClose={onClose} />);
      fireEvent.change(searchInput(), { target: { value: 'as' } });
      fireEvent.click(screen.getByText('Asha Rao'));
      fireEvent.change(amountInput(), { target: { value: '1499.50' } });
      fireEvent.change(descriptionInput(), { target: { value: 'Consultation' } });
      fireEvent.click(screen.getByRole('button', { name: /create link/i }));
      act(() => {
        mutations.createLink.mock.calls[0][1].onSuccess(result);
      });
      return { view, onClose };
    }

    it('swaps the form for the created link and its amount', () => {
      createLink();
      expect(screen.getByText('Payment link ready')).toBeInTheDocument();
      expect(screen.getByText('₹1,499.50')).toBeInTheDocument();
      expect(screen.getByText('https://rzp.io/i/abc')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /create link/i })).not.toBeInTheDocument();
    });

    it('confirms delivery when the link was messaged to the client', () => {
      createLink();
      expect(screen.getByText('The link was sent to the client.')).toBeInTheDocument();
    });

    it('asks the operator to share it when nothing was sent', () => {
      createLink({ ...linkResult, messageSent: false });
      expect(screen.getByText('Share this link with your client.')).toBeInTheDocument();
    });

    it('shows the long URL when Razorpay returned no short one', () => {
      createLink({
        ...linkResult,
        link: { ...linkResult.link, shortUrl: undefined as unknown as string },
      });
      expect(screen.getByText('https://rzp.io/i/full-length-link')).toBeInTheDocument();
    });

    it('always points Open at the canonical URL, not the shortened one', () => {
      createLink();
      const open = screen.getByLabelText('Open link').closest('a');
      expect(open).toHaveAttribute('href', 'https://rzp.io/i/full-length-link');
      expect(open).toHaveAttribute('rel', 'noreferrer');
    });

    it('copies the short link and reverts the button after two seconds', () => {
      vi.useFakeTimers();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      try {
        createLink();
        fireEvent.click(screen.getByRole('button', { name: /copy/i }));
        expect(writeText).toHaveBeenCalledWith('https://rzp.io/i/abc');
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not blow up when the browser exposes no clipboard', () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      createLink();
      expect(() => fireEvent.click(screen.getByRole('button', { name: /copy/i }))).not.toThrow();
    });

    it('clears the result so the next open starts on an empty form', () => {
      const { view, onClose } = createLink();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onClose).toHaveBeenCalledTimes(1);

      view.rerender(<CreatePaymentLinkModal open onClose={onClose} />);
      expect(screen.getByText('Generate payment link')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create link/i })).toBeDisabled();
    });
  });
});

// ── PaymentDetailDrawer ──────────────────────────────────────────────────────

describe('PaymentDetailDrawer', () => {
  const openRefund = () => fireEvent.click(screen.getByRole('button', { name: /refund/i }));

  it('renders nothing when no payment is selected', () => {
    const { container } = render(<PaymentDetailDrawer paymentId={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a spinner while the payment loads', () => {
    state.payment = { ...state.payment, data: undefined, isLoading: true };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByText('Loading payment…')).toBeInTheDocument();
  });

  it('offers a retry when the fetch failed', () => {
    const refetch = vi.fn();
    state.payment = { data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('titles the drawer with the amount and subtitles it with status and time', () => {
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: '₹2,500.00' })).toBeInTheDocument();
    expect(screen.getByText(/Captured · 1 Aug 2026/)).toBeInTheDocument();
  });

  it('lists the order and booking identifiers only when the payment has them', () => {
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.queryByText('Order')).not.toBeInTheDocument();
    expect(screen.queryByText('Booking')).not.toBeInTheDocument();

    state.payment = { ...state.payment, data: makePayment({ orderId: 'ord-9', bookingId: 'bk-9' }) };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getAllByText('Order')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Booking')[0]).toBeInTheDocument();
  });

  it('shows the failure reason on a failed payment', () => {
    state.payment = {
      ...state.payment,
      data: makePayment({ status: 'FAILED', failureReason: 'Insufficient funds' }),
    };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByText('Insufficient funds')).toBeInTheDocument();
  });

  it('renders the client card, falling back to the email when there is no phone', () => {
    state.payment = {
      ...state.payment,
      data: makePayment({
        client: { id: 'c2', name: 'Bhavin Shah', email: 'bhavin@example.com' } as Payment['client'],
      }),
    };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByText('bhavin@example.com')).toBeInTheDocument();
  });

  it('prefers the short payment link and shows its expiry', () => {
    state.payment = {
      ...state.payment,
      data: makePayment({
        paymentLinkUrl: 'https://rzp.io/i/long',
        paymentLinkShortUrl: 'https://rzp.io/i/s',
        paymentLinkExpiry: '2026-08-03T06:30:00.000Z',
      }),
    };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: /rzp\.io\/i\/s/ })).toHaveAttribute(
      'href',
      'https://rzp.io/i/s',
    );
    expect(screen.getByText(/Expires 3 Aug 2026/)).toBeInTheDocument();
  });

  describe('the refund ceiling', () => {
    it('subtracts refunds that already went through', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({ refunds: [makeRefund({ amount: 50_000 })] }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByText('Up to ₹2,000.00 can be refunded.')).toBeInTheDocument();
    });

    it('also subtracts refunds that are still pending', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({
          refunds: [makeRefund({ amount: 50_000, status: 'PENDING' })],
        }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByText('Up to ₹2,000.00 can be refunded.')).toBeInTheDocument();
    });

    it('gives back the money a failed refund never sent', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({
          refunds: [
            makeRefund({ id: 'rf-1', amount: 50_000, status: 'FAILED' }),
            makeRefund({ id: 'rf-2', amount: 25_000, status: 'PROCESSED' }),
          ],
        }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByText('Up to ₹2,250.00 can be refunded.')).toBeInTheDocument();
    });

    it('withdraws Refund entirely once the whole amount is back', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({
          status: 'PARTIALLY_REFUNDED',
          refunds: [makeRefund({ amount: 250_000 })],
        }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
    });

    it('caps the amount field at what is left', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({ refunds: [makeRefund({ amount: 50_000 })] }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '2000');
    });
  });

  it('summarises how much has gone back only once something has', () => {
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();

    state.payment = {
      ...state.payment,
      data: makePayment({ refunds: [makeRefund({ amount: 50_000 })] }),
    };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getAllByText('Refunded')[0]).toBeInTheDocument();
    expect(screen.getAllByText('₹500.00')[0]).toBeInTheDocument();
  });

  it('lists each refund with its reason and outcome', () => {
    state.payment = {
      ...state.payment,
      data: makePayment({
        refunds: [
          makeRefund({ id: 'rf-1', amount: 20_000, reason: 'Damaged', status: 'PROCESSED' }),
          makeRefund({ id: 'rf-2', amount: 10_000, reason: 'Late', status: 'PENDING' }),
          makeRefund({ id: 'rf-3', amount: 5_000, reason: 'Duplicate', status: 'FAILED' }),
        ],
      }),
    };
    render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
    expect(screen.getByText('Damaged')).toBeInTheDocument();
    expect(screen.getByText('Processed')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  describe('capture', () => {
    it('appears only for an authorised payment', () => {
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /capture/i })).not.toBeInTheDocument();

      state.payment = { ...state.payment, data: makePayment({ status: 'AUTHORIZED' }) };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(screen.getAllByRole('button', { name: /capture/i })[0]).toBeInTheDocument();
    });

    it('captures the payment by id', () => {
      state.payment = { ...state.payment, data: makePayment({ status: 'AUTHORIZED' }) };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /capture/i }));
      expect(mutations.capture).toHaveBeenCalledWith({ id: 'pay-11111111-2222' });
    });

    it('is not offered to an authorised payment when the operator cannot write', () => {
      role = 'VIEWER';
      state.payment = { ...state.payment, data: makePayment({ status: 'AUTHORIZED' }) };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /capture/i })).not.toBeInTheDocument();
    });
  });

  describe('refund', () => {
    it.each([
      ['PENDING', false],
      ['AUTHORIZED', false],
      ['CAPTURED', true],
      ['PARTIALLY_REFUNDED', true],
      ['REFUNDED', false],
      ['FAILED', false],
      ['EXPIRED', false],
    ] as Array<[PaymentStatus, boolean]>)('is %s-refundable: %s', (status, offered) => {
      state.payment = { ...state.payment, data: makePayment({ status }) };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(!!screen.queryByRole('button', { name: /refund/i })).toBe(offered);
    });

    it('stays hidden from a VIEWER', () => {
      role = 'VIEWER';
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
    });

    it('prefills the full refundable amount in rupees', () => {
      state.payment = {
        ...state.payment,
        data: makePayment({ amount: 250_000, refunds: [makeRefund({ amount: 50_050 })] }),
      };
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByRole('spinbutton')).toHaveValue(1999.5);
    });

    it('needs both an amount and a reason before it can be submitted', () => {
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      // Two buttons read "Refund" once the modal is up — the drawer's opener
      // and the modal's submit. Pick the submit by the form it posts.
      const submit = document.querySelector<HTMLButtonElement>('button[form="refund-form"]')!;
      const reason = screen.getByPlaceholderText(/why is this being refunded/i);
      // The amount arrives prefilled; the reason never does.
      expect(submit).toBeDisabled();

      fireEvent.change(reason, { target: { value: 'Cancelled' } });
      expect(submit).toBeEnabled();

      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
      expect(submit).toBeDisabled();

      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
      fireEvent.change(reason, { target: { value: '   ' } });
      expect(submit).toBeDisabled();
    });

    it('sends the refund in paise with a trimmed reason', () => {
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '750.25' } });
      fireEvent.change(screen.getByPlaceholderText(/why is this being refunded/i), {
        target: { value: '  Cancelled by client  ' },
      });
      fireEvent.submit(document.getElementById('refund-form')!);

      expect(mutations.refund.mock.calls[0][0]).toEqual({
        id: 'pay-11111111-2222',
        amount: 75_025,
        reason: 'Cancelled by client',
      });
    });

    it('closes and empties the form once the refund lands', () => {
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      fireEvent.change(screen.getByPlaceholderText(/why is this being refunded/i), {
        target: { value: 'Cancelled' },
      });
      fireEvent.submit(document.getElementById('refund-form')!);

      act(() => {
        mutations.refund.mock.calls[0][1].onSuccess();
      });
      expect(screen.queryByText('Issue refund')).not.toBeInTheDocument();

      openRefund();
      expect(screen.getByPlaceholderText(/why is this being refunded/i)).toHaveValue('');
    });

    it('keeps the form open and explains itself when the refund fails', () => {
      flags.refundError = true;
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      expect(screen.getByText(/couldn’t process the refund/i)).toBeInTheDocument();
      expect(screen.getByText('Issue refund')).toBeInTheDocument();
    });

    it('can be abandoned with Cancel', () => {
      render(<PaymentDetailDrawer paymentId="pay-1" onClose={vi.fn()} />);
      openRefund();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText('Issue refund')).not.toBeInTheDocument();
      expect(mutations.refund).not.toHaveBeenCalled();
    });
  });
});

// ── InvoiceDetailDrawer ──────────────────────────────────────────────────────

describe('InvoiceDetailDrawer', () => {
  const captured = makePayment({
    id: 'abcdef12-3456',
    status: 'CAPTURED',
    amount: 250_000,
    capturedAt: '2026-08-02T06:30:00.000Z',
  });

  it('renders nothing without a payment', () => {
    const { container } = render(<InvoiceDetailDrawer payment={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('derives the invoice number from the year and the payment id', () => {
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    expect(screen.getAllByText('INV-2026-ABCDEF12')[0]).toBeInTheDocument();
  });

  it('dates the invoice from the capture, not the creation', () => {
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    expect(screen.getByText('2 Aug 2026')).toBeInTheDocument();
  });

  it('falls back to the creation date for a payment never captured', () => {
    render(<InvoiceDetailDrawer payment={makePayment({ capturedAt: undefined })} onClose={vi.fn()} />);
    expect(screen.getByText('1 Aug 2026')).toBeInTheDocument();
  });

  it('names the business it is billed from once the profile loads', () => {
    expect(
      render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />).getByText('Your business'),
    ).toBeInTheDocument();

    state.business = {
      data: { name: 'Sunrise Interiors', email: 'hi@sunrise.in', phone: '+919000000000' },
    };
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    expect(screen.getByText('Sunrise Interiors')).toBeInTheDocument();
    expect(screen.getByText('hi@sunrise.in')).toBeInTheDocument();
    expect(screen.getByText('+919000000000')).toBeInTheDocument();
  });

  it('bills a single Payment line when there is no linked order', () => {
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getAllByText('₹2,500.00')).not.toHaveLength(0);
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
  });

  it('waits for the order before drawing lines it does not have yet', () => {
    state.order = { data: undefined, isLoading: true };
    render(
      <InvoiceDetailDrawer payment={makePayment({ orderId: 'ord-1' })} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Payment')).not.toBeInTheDocument();
  });

  it('itemises the linked order and totals it', () => {
    state.order = {
      data: {
        items: [
          { id: 'oi-1', name: 'Sofa cleaning', quantity: 2, total: 200_000 },
          { id: 'oi-2', name: 'Carpet shampoo', quantity: 1, total: 60_000 },
        ],
        subtotal: 260_000,
        discountAmount: 20_000,
        taxAmount: 10_000,
        shippingAmount: 0,
      },
      isLoading: false,
    };
    render(<InvoiceDetailDrawer payment={makePayment({ orderId: 'ord-1' })} onClose={vi.fn()} />);
    expect(screen.getByText('Sofa cleaning')).toBeInTheDocument();
    expect(screen.getByText('Carpet shampoo')).toBeInTheDocument();
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('− ₹200.00')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.queryByText('Shipping')).not.toBeInTheDocument();
  });

  it('shows shipping when the order carried a delivery charge', () => {
    state.order = {
      data: {
        items: [],
        subtotal: 250_000,
        discountAmount: 0,
        taxAmount: 0,
        shippingAmount: 5_000,
      },
      isLoading: false,
    };
    render(<InvoiceDetailDrawer payment={makePayment({ orderId: 'ord-1' })} onClose={vi.fn()} />);
    expect(screen.getByText('Shipping')).toBeInTheDocument();
    // No items on the order, so it falls back to the single payment line.
    expect(screen.getByText('Payment')).toBeInTheDocument();
  });

  it('always closes on the amount actually paid', () => {
    state.order = {
      data: { items: [], subtotal: 900_000, discountAmount: 0, taxAmount: 0, shippingAmount: 0 },
      isLoading: false,
    };
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    const totals = screen.getByText('Total paid').closest('div')!;
    expect(within(totals).getByText('₹2,500.00')).toBeInTheDocument();
  });

  it('tones the badge by payment status', () => {
    render(<InvoiceDetailDrawer payment={makePayment({ status: 'REFUNDED' })} onClose={vi.fn()} />);
    expect(screen.getByText('Refunded')).toBeInTheDocument();
  });

  it('notes the method used', () => {
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    expect(screen.getByText('Paid via Upi.')).toBeInTheDocument();
  });

  it('omits the method line when the payment never settled on one', () => {
    render(<InvoiceDetailDrawer payment={makePayment({ method: undefined })} onClose={vi.fn()} />);
    expect(screen.queryByText(/paid via/i)).not.toBeInTheDocument();
  });

  it('prints on request', () => {
    const print = vi.fn();
    Object.defineProperty(window, 'print', { value: print, configurable: true });
    render(<InvoiceDetailDrawer payment={captured} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /print/i }));
    expect(print).toHaveBeenCalled();
  });

  it('closes from the header', () => {
    const onClose = vi.fn();
    render(<InvoiceDetailDrawer payment={captured} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
