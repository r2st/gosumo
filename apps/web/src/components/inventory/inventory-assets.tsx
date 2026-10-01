'use client';

import {
  ExternalLink,
  FileText,
  IndianRupee,
  LayoutGrid,
  MapPin,
  Paperclip,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { formatDateIST } from '@/lib/format';
import { ASSET_TYPE_LABELS, type RealtyAsset, type RealtyAssetType } from '@/lib/realty-types';
import { cn } from '@/lib/utils';

const ASSET_ICON: Record<RealtyAssetType, LucideIcon> = {
  BROCHURE: FileText,
  FLOORPLAN: LayoutGrid,
  PRICESHEET: IndianRupee,
  VIDEO: Video,
  PIN: MapPin,
};

const ASSET_ICON_TINT: Record<RealtyAssetType, string> = {
  BROCHURE: 'bg-primary/15 text-primary',
  FLOORPLAN: 'bg-sky-500/15 text-sky-400',
  PRICESHEET: 'bg-emerald-500/15 text-emerald-400',
  VIDEO: 'bg-rose-500/15 text-rose-400',
  PIN: 'bg-amber-500/15 text-amber-400',
};

function AssetRow({ asset }: { asset: RealtyAsset }) {
  const Icon = ASSET_ICON[asset.type];
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          ASSET_ICON_TINT[asset.type],
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">
            {asset.title ?? ASSET_TYPE_LABELS[asset.type]}
          </p>
          <Badge tone="neutral">v{asset.version}</Badge>
          {!asset.isCurrent && <Badge tone="warning">Superseded</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {ASSET_TYPE_LABELS[asset.type]} · Uploaded {formatDateIST(asset.createdAt)}
        </p>
      </div>
      {asset.url && (
        <a
          href={asset.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted"
        >
          Open
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

/**
 * Verified media assets for a project — brochures, floor plans, price sheets,
 * videos. Assets are versioned; only the current version of each type is what
 * the AI sends, superseded ones are shown greyed for the broker's audit trail.
 */
export function InventoryAssets({ assets }: { assets: RealtyAsset[] }) {
  if (assets.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title="No assets uploaded"
        description="Publish the brochure, floor plans, and current price sheet so the AI can share them instantly on WhatsApp."
      />
    );
  }

  // Current versions first, then superseded — grouped by recency within each.
  const sorted = [...assets].sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return <ul className="divide-y divide-border">{sorted.map((a) => <AssetRow key={a.id} asset={a} />)}</ul>;
}
