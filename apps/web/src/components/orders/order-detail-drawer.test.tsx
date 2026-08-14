/**
 * The order detail drawer.
 *
 * The drawer is the operator's whole view of one order, so the tests pin the
 * parts that are computed rather than passed through: the totals block hides
 * a zero discount, tax or shipping line instead of printing "− ₹0.00", and the
 * timeline is assembled from whichever timestamps the order happens to carry —
 * a step with no timestamp has not happened and must not be drawn, while an
 * order that has only just been placed still needs to say something.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderAddress, OrderDetail } from '@/lib/commerce-types';
import type { OrderItem } from '@/lib/types';

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'oi-1',
    orderId: 'ord-1',
    catalogItemId: 'ci-1',
    name: 'Sofa cleaning',
    quantity: 2,
    unitPrice: 100_000,
    discountAmount: 0,
    taxAmount: 0,
    total: 200_000,
    ...overrides,
  };
}

function makeAddress(overrides: Partial<OrderAddress> = {}): OrderAddress {
  return {
    name: 'Asha Rao',
    phone: '+919800000001',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'KA',
    pincode: '560001',
    country: 'IN',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: 'ord-1',
    businessId: 'b1',
    clientId: 'c1',
    orderNumber: 'ORD-1042',
    status: 'PAID',
    fulfillmentType: 'DELIVERY',
    items: [makeItem()],
    subtotal: 200_000,
    discountAmount: 0,
    taxAmount: 0,
    shippingAmount: 0,
    total: 200_000,
    currency: 'INR',
    tags: [],
    metadata: {},
    createdAt: '2026-08-01T06:30:00.000Z',
    updatedAt: '2026-08-01T06:30:00.000Z',
    client: { id: 'c1', name: 'Asha Rao', phone: '+919800000001' },
    ...overrides,
  } as OrderDetail;
}

const state = {
  order: {
    data: makeOrder() as OrderDetail | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
};

vi.mock('@/hooks/use-orders', () => ({ useOrder: () => state.order }));

// The status control has its own suite; here it only needs to be present.
vi.mock('@/components/orders/order-status-control', () => ({
  OrderStatusControl: ({ order }: { order: OrderDetail }) => (
    <div data-testid="status-control">{order.status}</div>
  ),
}));

import { OrderDetailDrawer } from './order-detail-drawer';

beforeEach(() => {
  state.order = {
    data: makeOrder(),
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  vi.clearAllMocks();
});

describe('OrderDetailDrawer', () => {
  it('renders nothing until an order is selected', () => {
    const { container } = render(<OrderDetailDrawer orderId={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a spinner while the order loads', () => {
    state.order = { ...state.order, data: undefined, isLoading: true };
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.getByText('Loading order…')).toBeInTheDocument();
    expect(screen.queryByTestId('status-control')).not.toBeInTheDocument();
  });

  it('offers a retry when the fetch failed', () => {
    const refetch = vi.fn();
    state.order = { data: undefined, isLoading: false, isError: true, error: new Error('x'), refetch };
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('heads the drawer with the order number, item count and total', () => {
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'ORD-1042' })).toBeInTheDocument();
    expect(screen.getByText('1 item(s) · ₹2,000.00')).toBeInTheDocument();
  });

  it('hands the loaded order to the status control', () => {
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.getByTestId('status-control')).toHaveTextContent('PAID');
  });

  it('closes from the header', () => {
    const onClose = vi.fn();
    render(<OrderDetailDrawer orderId="ord-1" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('badges the status and the fulfilment type', () => {
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.getByText('Delivery')).toBeInTheDocument();
  });

  describe('the customer block', () => {
    it('shows the name and phone', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('Asha Rao')).toBeInTheDocument();
      expect(screen.getByText('+919800000001')).toBeInTheDocument();
    });

    it('falls back to the email when there is no phone', () => {
      state.order = {
        ...state.order,
        data: makeOrder({
          client: { id: 'c1', name: 'Bhavin', email: 'b@example.com' } as OrderDetail['client'],
        }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('b@example.com')).toBeInTheDocument();
    });

    it('dashes an order placed with no client attached', () => {
      state.order = { ...state.order, data: makeOrder({ client: undefined }) };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getAllByText('—')).not.toHaveLength(0);
    });
  });

  describe('the items list', () => {
    it('prices each line by quantity and unit price', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('Sofa cleaning')).toBeInTheDocument();
      expect(screen.getByText('2 × ₹1,000.00')).toBeInTheDocument();
    });

    it('appends the SKU when the line has one', () => {
      state.order = { ...state.order, data: makeOrder({ items: [makeItem({ sku: 'SKU-9' })] }) };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('2 × ₹1,000.00 · SKU-9')).toBeInTheDocument();
    });

    it('shows the item photo when there is one, and a placeholder otherwise', () => {
      const { container } = render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(container.querySelector('img')).toBeNull();

      state.order = {
        ...state.order,
        data: makeOrder({ items: [makeItem({ imageUrl: 'https://cdn/x.png' })] }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByAltText('Sofa cleaning')).toHaveAttribute('src', 'https://cdn/x.png');
    });
  });

  describe('the totals block', () => {
    it('shows only the subtotal and total when nothing else applies', () => {
      const { container } = render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      // "Shipping" also titles the tracking card, so read the totals list only.
      const totals = within(container.querySelector('dl')!);
      expect(totals.getByText('Subtotal')).toBeInTheDocument();
      expect(totals.getByText('Total')).toBeInTheDocument();
      expect(totals.queryByText('Discount')).toBeNull();
      expect(totals.queryByText('Tax')).toBeNull();
      expect(totals.queryByText('Shipping')).toBeNull();
    });

    it('adds discount, tax and shipping lines when they are non-zero', () => {
      state.order = {
        ...state.order,
        data: makeOrder({
          subtotal: 200_000,
          discountAmount: 20_000,
          taxAmount: 32_400,
          shippingAmount: 5_000,
          total: 217_400,
        }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('− ₹200.00')).toBeInTheDocument();
      expect(screen.getByText('₹324.00')).toBeInTheDocument();
      expect(screen.getByText('₹50.00')).toBeInTheDocument();
      const totalRow = screen.getByText('Total').closest('div')!;
      expect(within(totalRow).getByText('₹2,174.00')).toBeInTheDocument();
    });
  });

  describe('payment and shipping', () => {
    it('says when no payment is linked', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('No payment linked')).toBeInTheDocument();
    });

    it('truncates a linked payment id', () => {
      state.order = {
        ...state.order,
        data: makeOrder({ paymentId: 'pay-abcdefghijklmnop' }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('pay-abcdefgh…')).toBeInTheDocument();
    });

    it('says when nothing has shipped', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('Not shipped yet')).toBeInTheDocument();
    });

    it('shows the tracking number once there is one', () => {
      state.order = { ...state.order, data: makeOrder({ trackingNumber: 'TRK-77' }) };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('TRK-77')).toBeInTheDocument();
    });
  });

  describe('addresses', () => {
    it('are omitted entirely when the order carries none', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.queryByText('Addresses')).not.toBeInTheDocument();
    });

    it('joins the lines that exist, skipping the blank second line', () => {
      state.order = { ...state.order, data: makeOrder({ shippingAddress: makeAddress() }) };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('12 MG Road, Bengaluru, KA, 560001')).toBeInTheDocument();
    });

    it('includes the second line when it is filled in', () => {
      state.order = {
        ...state.order,
        data: makeOrder({ shippingAddress: makeAddress({ line2: 'Flat 3B' }) }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('12 MG Road, Flat 3B, Bengaluru, KA, 560001')).toBeInTheDocument();
    });

    it('shows shipping and billing side by side', () => {
      state.order = {
        ...state.order,
        data: makeOrder({
          shippingAddress: makeAddress(),
          billingAddress: makeAddress({ name: 'Accounts Dept' }),
        }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('Billing')).toBeInTheDocument();
      expect(screen.getByText('Accounts Dept')).toBeInTheDocument();
      // Two addresses, so the shipping name appears once and billing once.
      expect(screen.getAllByText('12 MG Road, Bengaluru, KA, 560001')).toHaveLength(2);
    });
  });

  it('shows the order notes when there are any', () => {
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();

    state.order = { ...state.order, data: makeOrder({ notes: 'Leave at the gate' }) };
    render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
    expect(screen.getByText('Leave at the gate')).toBeInTheDocument();
  });

  describe('the timeline', () => {
    it('draws only the steps that actually have a timestamp', () => {
      state.order = {
        ...state.order,
        data: makeOrder({
          confirmedAt: '2026-08-01T07:00:00.000Z',
          shippedAt: '2026-08-02T07:00:00.000Z',
        }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      const steps = screen.getAllByRole('listitem');
      expect(steps.map((s) => s.textContent?.split('1')[0])).toHaveLength(3);
      expect(screen.getByText('Order placed')).toBeInTheDocument();
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
      expect(screen.getByText('Shipped')).toBeInTheDocument();
      expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
      expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
    });

    it('appends a cancellation step at the end, after delivery', () => {
      state.order = {
        ...state.order,
        data: makeOrder({
          status: 'CANCELLED',
          confirmedAt: '2026-08-01T07:00:00.000Z',
          cancelledAt: '2026-08-03T07:00:00.000Z',
          cancelReason: 'Customer changed their mind',
        }),
      };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      const steps = screen.getAllByRole('listitem');
      expect(steps).toHaveLength(3);
      expect(steps[2]).toHaveTextContent('Cancelled');
      expect(screen.getByText(/Cancellation reason: Customer changed their mind/)).toBeInTheDocument();
    });

    it('says nothing has happened yet when even the placement time is missing', () => {
      state.order = { ...state.order, data: makeOrder({ createdAt: undefined as unknown as string }) };
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('No status changes yet.')).toBeInTheDocument();
    });

    it('renders each step with its IST timestamp', () => {
      render(<OrderDetailDrawer orderId="ord-1" onClose={vi.fn()} />);
      expect(screen.getByText('1 Aug 2026, 12:00 PM')).toBeInTheDocument();
    });
  });
});
