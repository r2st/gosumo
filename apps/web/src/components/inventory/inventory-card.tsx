'use client';

import { Building2, Home, Layers, MapPin, ShieldCheck } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { useProjectUnits } from '@/hooks/use-realty';
import { cn } from '@/lib/utils';
import {
  availableCount,
  configRange,
  freshness,
  latestVerifiedAt,
  unitPriceRange,
} from '@/lib/realty-ui';
import type { ProjectStatus, RealtyProject } from '@/lib/realty-types';

const STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  PRELAUNCH: 'info',
  UC: 'warning',
  RTM: 'success',
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  PRELAUNCH: 'Pre-launch',
  UC: 'UC',
  RTM: 'RTM',
};

// A gradient per status gives each photo-placeholder a distinct, on-brand tint.
const STATUS_GRADIENT: Record<ProjectStatus, string> = {
  PRELAUNCH: 'from-sky-100 to-indigo-100',
  UC: 'from-amber-100 to-orange-100',
  RTM: 'from-emerald-100 to-teal-100',
};

export function InventoryCard({ project }: { project: RealtyProject }) {
  const unitsQ = useProjectUnits(project.id);
  const units = unitsQ.data ?? [];

  const config = configRange(units);
  const price = unitPriceRange(units, {
    min: project.priceBandMinPaise,
    max: project.priceBandMaxPaise,
  });
  const available = availableCount(units);
  // Freshness comes from the most recently verified available unit (24h rule),
  // falling back to when the project record itself was last touched.
  const fresh = freshness(latestVerifiedAt(units) ?? project.updatedAt);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition hover:shadow-md">
      {/* Photo placeholder */}
      <div
        className={cn(
          'relative flex h-32 items-center justify-center bg-gradient-to-br',
          STATUS_GRADIENT[project.status],
        )}
      >
        <Building2 className="h-10 w-10 text-white/70" />
        <div className="absolute right-2.5 top-2.5 flex gap-1.5">
          <Badge tone={STATUS_TONE[project.status]}>{STATUS_LABEL[project.status]}</Badge>
        </div>
        {fresh && (
          <span
            className={cn(
              'absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              fresh.stale ? 'bg-rose-100 text-rose-700' : 'bg-sky-100 text-sky-700',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', fresh.stale ? 'bg-rose-500' : 'bg-sky-500')} />
            {fresh.label}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <div className="min-w-0">
          <p className="truncate font-semibold">{project.name}</p>
          {project.developer && (
            <p className="truncate text-xs text-muted-foreground">{project.developer}</p>
          )}
        </div>

        <p className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {project.locality}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          {config && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              {config}
            </span>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <Home className="h-3.5 w-3.5" />
            {unitsQ.isLoading ? '…' : `${available} available`}
          </span>
        </div>

        {price && <p className="mt-2 text-base font-bold tracking-tight">{price}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {project.reraNumber ? (
            <Badge tone="success" className="gap-1">
              <ShieldCheck className="h-3 w-3" />
              RERA {project.reraNumber}
            </Badge>
          ) : (
            <Badge tone="warning">RERA pending</Badge>
          )}
          {project.networkVisibility === 'EXCHANGE' && <Badge tone="primary">Exchange</Badge>}
        </div>
      </div>
    </div>
  );
}
