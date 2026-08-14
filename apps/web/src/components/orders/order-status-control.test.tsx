/**
 * The order status control decides which state transitions an operator is
 * offered. Getting the map wrong either strands orders (a missing forward
 * button) or offers a move the API will reject, so the suite walks every
 * status and asserts the exact set of controls it renders — plus the two
 * prompts that gate a write behind extra input.
 *
 * Role gating is covered in src/__tests__/viewer-gating.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Order, OrderStatus } from '@/lib/types';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canWrite: true }),
}));

interface MutationStub {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
}
const stub = (): MutationStub => ({
  mutate: vi.fn(),
  isPending: false,
  isError: false,
});

const confirm = stub();
const fulfill = stub();
const advance = stub();
const cancel = stub();

vi.mock('@/hooks/use-orders', () => ({
  useConfirmOrder: () => confirm,
  useFulfillOrder: () => fulfill,
  useUpdateOrderStatus: () => advance,
  useCancelOrder: () => cancel,
}));

const { OrderStatusControl } = await import('./order-status-control');

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 'order-1',
    businessId: 'b1',
    orderNumber: 'ORD-1042',
    status: 'DRAFT' as OrderStatus,
    items: [],
    subtotalPaise: 100_000,
    totalPaise: 100_000,
    paymentId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }) as Order;

/** Button labels currently offered, ignoring anything inside a closed modal. */
const actionLabels = (): string[] =>
  screen
    .queryAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter(Boolean);

/** Resolve the last mutate call's onSuccess, if the caller supplied one. */
const succeed = (m: MutationStub): void => {
  const call = m.mutate.mock.calls.at(-1) as [unknown, { onSuccess?: () => void }?];
  act(() => call[1]?.onSuccess?.());
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [confirm, fulfill, advance, cancel]) {
    m.isPending = false;
    m.isError = false;
  }
});

describe('offered transitions by status', () => {
  it('offers only Confirm (and Cancel) on a draft', () => {
    render(<OrderStatusControl order={order({ status: 'DRAFT' })} />);
    expect(actionLabels()).toEqual(['Confirm order', 'Cancel']);
  });

  it('offers the payment transition while awaiting payment', () => {
    render(<OrderStatusControl order={order({ status: 'PENDING_PAYMENT' })} />);
    expect(screen.getByRole('button', { name: /mark paid/i })).toBeTruthy();
  });

  it('offers both fulfilment and the processing transition once paid', () => {
    render(<OrderStatusControl order={order({ status: 'PAID' })} />);
    expect(screen.getByRole('button', { name: /mark fulfilled/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /mark processing/i })).toBeTruthy();
  });

  it('offers both despatch routes while processing', () => {
    render(<OrderStatusControl order={order({ status: 'PROCESSING' })} />);
    expect(screen.getByRole('button', { name: /mark ready for pickup/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /mark shipped/i })).toBeTruthy();
  });

  it('offers delivery from ready-for-pickup', () => {
    render(<OrderStatusControl order={order({ status: 'READY_FOR_PICKUP' })} />);
    expect(screen.getByRole('button', { name: /mark delivered/i })).toBeTruthy();
  });

  it('offers delivery from shipped', () => {
    render(<OrderStatusControl order={order({ status: 'SHIPPED' })} />);
    expect(screen.getByRole('button', { name: /mark delivered/i })).toBeTruthy();
  });

  it.each(['DELIVERED', 'CANCELLED', 'REFUNDED'] as OrderStatus[])(
    'offers nothing at all on a %s order',
    (status) => {
      render(<OrderStatusControl order={order({ status })} />);
      expect(actionLabels()).toEqual([]);
    },
  );

  it('offers Cancel on every non-terminal status', () => {
    const nonTerminal: OrderStatus[] = [
      'DRAFT',
      'PENDING_PAYMENT',
      'PAID',
      'PROCESSING',
      'READY_FOR_PICKUP',
      'SHIPPED',
    ];
    for (const status of nonTerminal) {
      const { unmount } = render(<OrderStatusControl order={order({ status })} />);
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
      unmount();
    }
  });
});

describe('direct writes', () => {
  it('confirms a draft order', () => {
    render(<OrderStatusControl order={order({ status: 'DRAFT' })} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm order/i }));
    expect(confirm.mutate).toHaveBeenCalledWith({ id: 'order-1' });
  });

  it('fulfils a paid order', () => {
    render(<OrderStatusControl order={order({ status: 'PAID' })} />);
    fireEvent.click(screen.getByRole('button', { name: /mark fulfilled/i }));
    expect(fulfill.mutate).toHaveBeenCalledWith({ id: 'order-1' });
  });

  it('advances a non-shipping transition without prompting', () => {
    render(<OrderStatusControl order={order({ status: 'PROCESSING' })} />);
    fireEvent.click(screen.getByRole('button', { name: /mark ready for pickup/i }));
    expect(advance.mutate).toHaveBeenCalledWith({
      id: 'order-1',
      status: 'READY_FOR_PICKUP',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('shipping prompt', () => {
  const openShip = (): void => {
    render(<OrderStatusControl order={order({ status: 'PROCESSING' })} />);
    fireEvent.click(screen.getByRole('button', { name: /^mark shipped$/i }));
  };

  it('collects a tracking number instead of writing straight away', () => {
    openShip();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(advance.mutate).not.toHaveBeenCalled();
  });

  it('sends the tracking number with the transition', () => {
    openShip();
    fireEvent.change(screen.getByPlaceholderText(/EKART/i), {
      target: { value: 'EKART-12345678' },
    });
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    expect(advance.mutate).toHaveBeenCalledWith(
      { id: 'order-1', status: 'SHIPPED', trackingNumber: 'EKART-12345678' },
      expect.anything(),
    );
  });

  it('trims the tracking number before sending it', () => {
    openShip();
    fireEvent.change(screen.getByPlaceholderText(/EKART/i), {
      target: { value: '  EKART-999  ' },
    });
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    expect(advance.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ trackingNumber: 'EKART-999' }),
      expect.anything(),
    );
  });

  it('omits the tracking number entirely when it is left blank', () => {
    // Tracking is optional — sending "" would store an empty tracking id the
    // customer could click through to.
    openShip();
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    expect(advance.mutate).toHaveBeenCalledWith(
      { id: 'order-1', status: 'SHIPPED', trackingNumber: undefined },
      expect.anything(),
    );
  });

  it('omits a whitespace-only tracking number', () => {
    openShip();
    fireEvent.change(screen.getByPlaceholderText(/EKART/i), {
      target: { value: '   ' },
    });
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    expect(advance.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ trackingNumber: undefined }),
      expect.anything(),
    );
  });

  it('closes and clears the field once the write lands', () => {
    openShip();
    fireEvent.change(screen.getByPlaceholderText(/EKART/i), {
      target: { value: 'EKART-1' },
    });
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    succeed(advance);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Re-opening must not show the previous order's tracking number.
    fireEvent.click(screen.getByRole('button', { name: /^mark shipped$/i }));
    expect((screen.getByPlaceholderText(/EKART/i) as HTMLInputElement).value).toBe('');
  });

  it('stays open when the write fails', () => {
    openShip();
    fireEvent.submit(document.getElementById('ship-form') as HTMLFormElement);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes without writing when dismissed', () => {
    openShip();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(advance.mutate).not.toHaveBeenCalled();
  });
});

describe('cancel prompt', () => {
  const openCancel = (o: Order = order({ status: 'PAID' })): void => {
    render(<OrderStatusControl order={o} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
  };

  it('names the order being cancelled', () => {
    openCancel();
    expect(screen.getByText(/ORD-1042 will be cancelled/)).toBeTruthy();
  });

  it('refuses to submit without a reason', () => {
    openCancel();
    const submit = screen.getByRole('button', {
      name: /cancel order/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('stays disabled for a whitespace-only reason', () => {
    openCancel();
    fireEvent.change(screen.getByPlaceholderText(/why is this order/i), { target: { value: '   ' } });
    expect(
      (screen.getByRole('button', { name: /cancel order/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('cancels with the trimmed reason', () => {
    openCancel();
    fireEvent.change(screen.getByPlaceholderText(/why is this order/i), {
      target: { value: '  customer changed their mind  ' },
    });
    fireEvent.submit(document.getElementById('cancel-form') as HTMLFormElement);
    expect(cancel.mutate).toHaveBeenCalledWith(
      {
        id: 'order-1',
        reason: 'customer changed their mind',
        refundPayment: true,
      },
      expect.anything(),
    );
  });

  it('hides the refund toggle when nothing was ever paid', () => {
    openCancel(order({ status: 'DRAFT', paymentId: null }));
    expect(screen.queryByText(/refund payment/i)).toBeNull();
  });

  it('offers the refund toggle, defaulted on, once a payment exists', () => {
    openCancel(order({ status: 'PAID', paymentId: 'pay-1' }));
    expect(screen.getByText(/refund payment/i)).toBeTruthy();
  });

  it('cancels without a refund when the operator turns it off', () => {
    openCancel(order({ status: 'PAID', paymentId: 'pay-1' }));
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByPlaceholderText(/why is this order/i), {
      target: { value: 'duplicate order' },
    });
    fireEvent.submit(document.getElementById('cancel-form') as HTMLFormElement);
    expect(cancel.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ refundPayment: false }),
      expect.anything(),
    );
  });

  it('closes once the cancellation lands', () => {
    openCancel();
    fireEvent.change(screen.getByPlaceholderText(/why is this order/i), {
      target: { value: 'out of stock' },
    });
    fireEvent.submit(document.getElementById('cancel-form') as HTMLFormElement);
    succeed(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the failure inline and keeps the prompt open', () => {
    cancel.isError = true;
    openCancel();
    expect(screen.getByText(/couldn’t cancel the order/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes without writing when the operator keeps the order', () => {
    openCancel();
    fireEvent.click(screen.getByRole('button', { name: /keep order/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cancel.mutate).not.toHaveBeenCalled();
  });
});
