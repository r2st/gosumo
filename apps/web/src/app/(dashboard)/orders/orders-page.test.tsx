/**
 * The orders list page.
 *
 * The filters are the whole point of this page, so the tests pin what reaches
 * the API: an unset select must send `undefined` rather than the empty string
 * it holds, or the request narrows to a status that does not exist and the
 * operator sees an empty list they cannot explain. The footer count is checked
 * against the paginated total too — "showing 20 of 20" when there are 340 is a
 * quiet way to lose orders.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '@/lib/types';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    businessId: 'b1',
    clientId: 'c1',
    orderNumber: 'ORD-1042',
    status: 'PAID',
    fulfillmentType: 'DELIVERY',
    items: [
      { id: 'oi-1', name: 'Sofa cleaning', quantity: 2 },
      { id: 'oi-2', name: 'Carpet shampoo', quantity: 1 },
    ],
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
  } as Order;
}

const state = {
  orders: {
    data: {
      data: [makeOrder()],
      pagination: { page: 1, limit: 20, total: 340, totalPages: 17 },
    } as { data: Order[]; pagination: { total: number } } | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
};

/** The filters the page last asked the orders endpoint for. */
let listArgs: Record<string, unknown> | null = null;

vi.mock('@/hooks/use-orders', () => ({
  useOrders: (args: Record<string, unknown>) => {
    listArgs = args;
    return state.orders;
  },
}));

vi.mock('@/components/orders/order-detail-drawer', () => ({
  OrderDetailDrawer: ({ orderId }: { orderId: string | null }) =>
    orderId ? <div data-testid="order-drawer">{orderId}</div> : null,
}));

import OrdersPage from './page';

beforeEach(() => {
  state.orders = {
    data: {
      data: [makeOrder()],
      pagination: { page: 1, limit: 20, total: 340, totalPages: 17 },
    },
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  listArgs = null;
  vi.clearAllMocks();
});

describe('OrdersPage', () => {
  it('heads the page and lists the seven columns', () => {
    render(<OrdersPage />);
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
  });

  it('sends no filters at all before anything is chosen', () => {
    render(<OrdersPage />);
    expect(listArgs).toEqual({ status: undefined, fulfillmentType: undefined, q: undefined });
  });

  it('sends the chosen status, fulfilment and search text', () => {
    render(<OrdersPage />);
    const [status, fulfilment] = screen.getAllByRole('combobox');
    fireEvent.change(status, { target: { value: 'SHIPPED' } });
    fireEvent.change(fulfilment, { target: { value: 'PICKUP' } });
    fireEvent.change(screen.getByPlaceholderText('Search order #…'), {
      target: { value: 'ORD-10' },
    });
    expect(listArgs).toEqual({ status: 'SHIPPED', fulfillmentType: 'PICKUP', q: 'ORD-10' });
  });

  it('drops a filter back to undefined when it is cleared again', () => {
    render(<OrdersPage />);
    const [status] = screen.getAllByRole('combobox');
    fireEvent.change(status, { target: { value: 'SHIPPED' } });
    fireEvent.change(status, { target: { value: '' } });
    expect(listArgs).toMatchObject({ status: undefined });
  });

  it('offers every order status and fulfilment type', () => {
    render(<OrdersPage />);
    const [status, fulfilment] = screen.getAllByRole('combobox');
    expect(within(status).getAllByRole('option')).toHaveLength(10);
    expect(within(fulfilment).getAllByRole('option')).toHaveLength(5);
    expect(within(status).getByRole('option', { name: 'Ready For Pickup' })).toBeInTheDocument();
    expect(within(fulfilment).getByRole('option', { name: 'In Store' })).toBeInTheDocument();
  });

  it('shows a labelled skeleton while the first page loads', () => {
    state.orders = { ...state.orders, data: undefined, isLoading: true };
    render(<OrdersPage />);
    expect(screen.getByText('Loading orders…')).toBeInTheDocument();
  });

  it('offers a retry when the list fails', () => {
    const refetch = vi.fn();
    state.orders = { data: undefined, isLoading: false, isError: true, error: new Error('x'), refetch };
    render(<OrdersPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('says so when there are no orders', () => {
    state.orders = {
      ...state.orders,
      data: { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    };
    render(<OrdersPage />);
    expect(screen.getByText('No orders found')).toBeInTheDocument();
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
  });

  it('survives a response body that never arrived', () => {
    state.orders = { ...state.orders, data: undefined, isLoading: false };
    render(<OrdersPage />);
    expect(screen.getByText('No orders found')).toBeInTheDocument();
  });

  it('renders an order row end to end', () => {
    render(<OrdersPage />);
    const row = screen.getByText('ORD-1042').closest('tr')!;
    expect(within(row).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(row).getByText('2 item(s)')).toBeInTheDocument();
    expect(within(row).getByText('Delivery')).toBeInTheDocument();
    expect(within(row).getByText('₹2,000.00')).toBeInTheDocument();
    expect(within(row).getByText('1 Aug 2026')).toBeInTheDocument();
  });

  it('counts zero items for an order whose lines were not expanded', () => {
    state.orders = {
      ...state.orders,
      data: {
        data: [makeOrder({ items: undefined as unknown as Order['items'] })],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    };
    render(<OrdersPage />);
    expect(screen.getByText('0 item(s)')).toBeInTheDocument();
  });

  it('dashes an order with no client attached', () => {
    state.orders = {
      ...state.orders,
      data: {
        data: [makeOrder({ client: undefined })],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    };
    render(<OrdersPage />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('reports the page size against the full total, not against itself', () => {
    render(<OrdersPage />);
    expect(screen.getByText('Showing 1 of 340 orders')).toBeInTheDocument();
  });

  it('opens the detail drawer for the clicked row and closes it again', () => {
    render(<OrdersPage />);
    expect(screen.queryByTestId('order-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('ORD-1042'));
    expect(screen.getByTestId('order-drawer')).toHaveTextContent('ord-1');
  });
});
