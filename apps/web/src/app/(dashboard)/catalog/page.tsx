'use client';

import { useState } from 'react';
import { FolderTree, Package, Pencil, Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { StockBadge } from '@/components/catalog/stock-badge';
import { ProductFormModal } from '@/components/catalog/product-form-modal';
import { CategoryManager } from '@/components/catalog/category-manager';
import { useCatalogItems, useCategories } from '@/hooks/use-catalog';
import { paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CatalogItem, CatalogItemType } from '@/lib/types';

const TYPES = [
  { label: 'All', value: '' },
  { label: 'Products', value: 'PRODUCT' },
  { label: 'Services', value: 'SERVICE' },
  { label: 'Packages', value: 'PACKAGE' },
  { label: 'Digital', value: 'DIGITAL' },
];

export default function CatalogPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);

  const categoriesQ = useCategories();
  const categories = categoriesQ.data?.categories ?? [];

  const { data, isLoading, isError, error, refetch } = useCatalogItems({
    q: q || undefined,
    type: (type || undefined) as CatalogItemType | undefined,
    categoryId: categoryId || undefined,
    lowStock: lowStock || undefined,
  });

  const openNew = () => {
    setEditItem(null);
    setFormOpen(true);
  };
  const openEdit = (item: CatalogItem) => {
    setEditItem(item);
    setFormOpen(true);
  };

  return (
    <div>
      <PageHeader
        title="Catalog"
        description="Your products, services and packages."
        actions={
          <>
            <Button variant="outline" onClick={() => setCategoryOpen(true)}>
              <FolderTree className="h-4 w-4" /> Categories
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  type === t.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="w-full sm:w-48">
              <Select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                options={[{ label: 'All categories', value: '' }, ...categories.map((c) => ({ label: c.name, value: c.id }))]}
              />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={lowStock} onChange={setLowStock} /> Low stock only
            </label>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search catalog…" className="pl-8" />
            </div>
          </div>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
        ) : !data || data.data.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No catalog items"
            description="Add your first product or service to get started."
            action={
              <Button onClick={openNew}>
                <Plus className="h-4 w-4" /> Add item
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.data.map((item) => (
              <Card key={item.id} className="group overflow-hidden">
                <div className="relative aspect-video w-full bg-muted">
                  {item.imageUrls?.[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrls[0]} alt={item.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Package className="h-8 w-8" />
                    </div>
                  )}
                  <button
                    onClick={() => openEdit(item)}
                    className="absolute right-2 top-2 rounded-md bg-card/90 p-1.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
                    aria-label={`Edit ${item.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {!item.isActive && (
                    <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                      Inactive
                    </span>
                  )}
                </div>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-sm font-semibold">{item.name}</h3>
                    <StockBadge item={item} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {item.shortDescription ?? item.description ?? '—'}
                  </p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-base font-bold">
                      {item.discountPrice ? (
                        <>
                          {paiseToRupees(item.discountPrice)}{' '}
                          <span className="text-xs font-normal text-muted-foreground line-through">
                            {paiseToRupees(item.basePrice)}
                          </span>
                        </>
                      ) : (
                        paiseToRupees(item.basePrice)
                      )}
                    </span>
                    <Badge tone="info">{item.type}</Badge>
                  </div>
                  {(item.variants?.length ?? 0) > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {item.variants.length} variant{item.variants.length === 1 ? '' : 's'}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {data && data.data.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {data.data.length} of {data.pagination?.total ?? (data as any).total ?? '?'} items
          </p>
        )}
      </div>

      <ProductFormModal open={formOpen} onClose={() => setFormOpen(false)} item={editItem} categories={categories} />
      <CategoryManager open={categoryOpen} onClose={() => setCategoryOpen(false)} />
    </div>
  );
}
