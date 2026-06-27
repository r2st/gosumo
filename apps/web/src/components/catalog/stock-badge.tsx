import { Badge, type BadgeTone } from '@/components/ui/badge';
import { stockStateFor, type StockState } from '@/lib/commerce-types';
import type { CatalogItem } from '@/lib/types';

const LABEL: Record<StockState, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  UNTRACKED: 'Available',
};

const TONE: Record<StockState, BadgeTone> = {
  IN_STOCK: 'success',
  LOW_STOCK: 'warning',
  OUT_OF_STOCK: 'danger',
  UNTRACKED: 'neutral',
};

/** Inventory status pill derived from the item's tracking + stock levels. */
export function StockBadge({ item, className }: { item: CatalogItem; className?: string }) {
  const state = stockStateFor(item);
  const qty = item.trackInventory && item.stockQuantity != null ? ` · ${item.stockQuantity}` : '';
  return (
    <Badge tone={TONE[state]} className={className}>
      {LABEL[state]}
      {qty}
    </Badge>
  );
}
