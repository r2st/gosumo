import { describe, expect, it } from 'vitest';
import { invoiceNumber, isInvoiceable, stockStateFor } from './commerce-types';
import type { CatalogItem, Payment, PaymentStatus } from './types';

type StockFields = Pick<CatalogItem, 'trackInventory' | 'stockQuantity' | 'lowStockThreshold'>;

/**
 * `stockQuantity` and `lowStockThreshold` are declared optional, but the API
 * sends explicit JSON nulls — which is why `stockStateFor` guards with `?? 0`
 * and `!= null` rather than `?? `/truthiness. These helpers let the tests feed
 * it the values it actually receives over the wire.
 */
function stockItem(item: {
  trackInventory: boolean;
  stockQuantity?: number | null;
  lowStockThreshold?: number | null;
}) {
  return stockStateFor(item as StockFields);
}

/** `createdAt` is required on the type, but a freshly-created payment can arrive without it. */
function invoiceFor(payment: { id: string; createdAt?: string }) {
  return invoiceNumber(payment as Pick<Payment, 'id' | 'createdAt'>);
}

describe('stockStateFor', () => {
  it('reports UNTRACKED when the item does not track inventory at all', () => {
    // An untracked item must never read as out of stock — a service or a
    // made-to-order product would otherwise be unsellable in the catalog UI.
    expect(
      stockItem({ trackInventory: false, stockQuantity: 0, lowStockThreshold: 5 }),
    ).toBe('UNTRACKED');
  });

  it('ignores quantity entirely once tracking is off', () => {
    expect(
      stockItem({ trackInventory: false, stockQuantity: 999, lowStockThreshold: null }),
    ).toBe('UNTRACKED');
  });

  it('reports OUT_OF_STOCK at zero', () => {
    expect(stockItem({ trackInventory: true, stockQuantity: 0, lowStockThreshold: 5 })).toBe(
      'OUT_OF_STOCK',
    );
  });

  it('treats a negative quantity as out of stock rather than low stock', () => {
    // Oversell can drive the count below zero; it is still unsellable, and
    // must not slip into LOW_STOCK just because it is under the threshold.
    expect(stockItem({ trackInventory: true, stockQuantity: -3, lowStockThreshold: 5 })).toBe(
      'OUT_OF_STOCK',
    );
  });

  it('treats a missing quantity as zero', () => {
    expect(
      stockItem({ trackInventory: true, stockQuantity: null, lowStockThreshold: 5 }),
    ).toBe('OUT_OF_STOCK');
  });

  it('reports LOW_STOCK at and below the threshold', () => {
    expect(stockItem({ trackInventory: true, stockQuantity: 5, lowStockThreshold: 5 })).toBe(
      'LOW_STOCK',
    );
    expect(stockItem({ trackInventory: true, stockQuantity: 1, lowStockThreshold: 5 })).toBe(
      'LOW_STOCK',
    );
  });

  it('reports IN_STOCK just above the threshold', () => {
    expect(stockItem({ trackInventory: true, stockQuantity: 6, lowStockThreshold: 5 })).toBe(
      'IN_STOCK',
    );
  });

  it('reports IN_STOCK for any positive quantity when no threshold is set', () => {
    expect(
      stockItem({ trackInventory: true, stockQuantity: 1, lowStockThreshold: null }),
    ).toBe('IN_STOCK');
    expect(
      stockItem({ trackInventory: true, stockQuantity: 1, lowStockThreshold: undefined }),
    ).toBe('IN_STOCK');
  });

  it('treats a zero threshold as a real threshold, not an absent one', () => {
    // `lowStockThreshold: 0` is falsy but meaningful — the check is `!= null`,
    // and a truthiness check here would silently disable the threshold.
    expect(stockItem({ trackInventory: true, stockQuantity: 4, lowStockThreshold: 0 })).toBe(
      'IN_STOCK',
    );
  });
});

describe('invoiceNumber', () => {
  it('builds INV-<year>-<uppercased id prefix>', () => {
    expect(
      invoiceFor({ id: '3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b', createdAt: '2026-07-14T09:00:00.000Z' }),
    ).toBe('INV-2026-3F2A9C1E');
  });

  it('falls back to year 0000 when the payment has no creation date', () => {
    expect(invoiceFor({ id: 'abcdef12-0000-0000-0000-000000000000', createdAt: undefined })).toBe(
      'INV-0000-ABCDEF12',
    );
  });

  it('does not pad a short id', () => {
    expect(invoiceFor({ id: 'ab12', createdAt: '2025-01-01T00:00:00.000Z' })).toBe(
      'INV-2025-AB12',
    );
  });

  it('is stable for the same payment, since the number is printed on documents', () => {
    const payment = { id: '9c1e3f2a-1111-2222-3333-444444444444', createdAt: '2026-02-02T00:00:00.000Z' };
    expect(invoiceNumber(payment)).toBe(invoiceNumber(payment));
  });

  it('distinguishes two payments created in the same year', () => {
    const year = '2026-03-03T00:00:00.000Z';
    expect(invoiceFor({ id: 'aaaaaaaa-1', createdAt: year })).not.toBe(
      invoiceFor({ id: 'bbbbbbbb-1', createdAt: year }),
    );
  });
});

describe('isInvoiceable', () => {
  it('invoices money that actually reached the merchant', () => {
    expect(isInvoiceable('CAPTURED')).toBe(true);
    expect(isInvoiceable('PARTIALLY_REFUNDED')).toBe(true);
    expect(isInvoiceable('REFUNDED')).toBe(true);
  });

  it('does not invoice a payment that never captured', () => {
    // Issuing an invoice for an authorized-but-uncaptured or failed payment
    // would put a document in a buyer's hands for money never taken.
    const notYet: PaymentStatus[] = ['PENDING', 'AUTHORIZED', 'FAILED', 'EXPIRED'];
    for (const status of notYet) {
      expect(isInvoiceable(status)).toBe(false);
    }
  });

  it('classifies every PaymentStatus one way or the other', () => {
    const all: PaymentStatus[] = [
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'EXPIRED',
    ];
    for (const status of all) {
      expect(typeof isInvoiceable(status)).toBe('boolean');
    }
  });
});
