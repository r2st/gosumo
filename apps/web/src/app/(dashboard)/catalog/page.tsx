'use client';

import { useState } from 'react';
import { Package, Search } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { useCatalogItems } from '@/hooks/use-queries';
import { paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';

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
  const { data, isLoading, isError, error, refetch } = useCatalogItems({ q: q || undefined, type: type || undefined });

  return (
    <div>
      <PageHeader title="Catalog" description="Your products, services and packages." />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
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
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search catalog…" className="pl-8" />
          </div>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
        ) : !data || data.data.length === 0 ? (
          <EmptyState icon={Package} title="No catalog items" description="Items added in the catalog will appear here." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.data.map((item) => (
              <Card key={item.id} className="overflow-hidden">
                <div className="aspect-video w-full bg-muted">
                  {item.imageUrls[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrls[0]} alt={item.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Package className="h-8 w-8" />
                    </div>
                  )}
                </div>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-sm font-semibold">{item.name}</h3>
                    <Badge tone={item.isAvailable ? 'success' : 'neutral'}>
                      {item.isAvailable ? 'Available' : 'Unavailable'}
                    </Badge>
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
                  {item.trackInventory && (
                    <p className="mt-2 text-xs text-muted-foreground">Stock: {item.stockQuantity ?? 0}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
