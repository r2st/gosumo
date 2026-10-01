'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Boxes,
  Building2,
  CalendarClock,
  ChevronRight,
  IndianRupee,
  MapPin,
  Network,
  Paperclip,
  Receipt,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { InventoryUnitsTable } from '@/components/inventory/inventory-units-table';
import { InventoryAssets } from '@/components/inventory/inventory-assets';
import { InventoryVisibilityToggle } from '@/components/inventory/inventory-visibility-toggle';
import { InventoryCommission } from '@/components/inventory/inventory-commission';
import { useProject, useProjectAssets, useProjectUnits } from '@/hooks/use-realty';
import { formatDateIST } from '@/lib/format';
import { availableCount, unitPriceRange, PROJECT_STATUS_TONE } from '@/lib/realty-ui';
import { PROJECT_STATUS_LABELS, type RealtyProject } from '@/lib/realty-types';

export default function InventoryDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params?.projectId ?? null;
  const router = useRouter();
  const { data: project, isLoading, isError, error, refetch } = useProject(projectId);

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 border-b border-border bg-card px-4 py-3 text-sm lg:px-6"
      >
        <Link href="/inventory" className="text-muted-foreground hover:text-foreground">
          Inventory
        </Link>
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium text-foreground">
          {project?.name ?? (isLoading ? 'Loading…' : 'Project')}
        </span>
      </nav>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {isLoading ? (
          <LoadingState label="Loading project…" />
        ) : isError ? (
          <ErrorState message="Could not load this project." error={error} onRetry={() => refetch()} />
        ) : !project ? (
          <EmptyState
            icon={Building2}
            title="Project not found"
            description="This project may have been removed."
            action={
              <button
                onClick={() => router.push('/inventory')}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                Back to inventory
              </button>
            }
          />
        ) : (
          <ProjectDetail project={project} projectId={project.id} />
        )}
      </div>
    </div>
  );
}

function ProjectDetail({ project, projectId }: { project: RealtyProject; projectId: string }) {
  const unitsQ = useProjectUnits(projectId);
  const assetsQ = useProjectAssets(projectId);
  const units = unitsQ.data ?? [];

  const price = unitPriceRange(units, {
    min: project.priceBandMinPaise,
    max: project.priceBandMaxPaise,
  });
  const available = availableCount(units);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      {/* Header */}
      <ProjectHeader project={project} price={price} availableUnits={available} totalUnits={units.length} />

      {/* Units */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-1.5">
            <Boxes className="h-4 w-4" />
            Units
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {available} available · {units.length} total
          </span>
        </CardHeader>
        <CardContent className="px-0 sm:px-2">
          {unitsQ.isLoading ? (
            <LoadingState label="Loading units…" />
          ) : unitsQ.isError ? (
            <ErrorState message="Could not load units." error={unitsQ.error} onRetry={() => unitsQ.refetch()} />
          ) : (
            <InventoryUnitsTable units={units} />
          )}
        </CardContent>
      </Card>

      {/* Assets + broker controls. grid-cols-1 keeps the mobile column bounded to the
          viewport (minmax(0,1fr)); a bare `grid` would grow to its widest nowrap child
          inside the scroll container and push content off-screen. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Paperclip className="h-4 w-4" />
                Assets
              </CardTitle>
            </CardHeader>
            <CardContent>
              {assetsQ.isLoading ? (
                <LoadingState label="Loading assets…" />
              ) : assetsQ.isError ? (
                <ErrorState message="Could not load assets." error={assetsQ.error} onRetry={() => assetsQ.refetch()} />
              ) : (
                <InventoryAssets assets={assetsQ.data ?? []} />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Network className="h-4 w-4" />
                Network visibility
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InventoryVisibilityToggle project={project} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Receipt className="h-4 w-4" />
                Commission terms
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InventoryCommission terms={project.commissionTerms} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ProjectHeader({
  project,
  price,
  availableUnits,
  totalUnits,
}: {
  project: RealtyProject;
  price: string | null;
  availableUnits: number;
  totalUnits: number;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Building2 className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight">{project.name}</h1>
            {project.developer && (
              <p className="truncate text-sm text-muted-foreground">{project.developer}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={PROJECT_STATUS_TONE[project.status]}>
                {PROJECT_STATUS_LABELS[project.status]}
              </Badge>
              {project.reraNumber ? (
                <Badge tone="success" className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  RERA {project.reraNumber}
                </Badge>
              ) : (
                <Badge tone="warning">RERA pending</Badge>
              )}
              <Badge tone={project.networkVisibility === 'EXCHANGE' ? 'primary' : 'neutral'}>
                {project.networkVisibility === 'EXCHANGE' ? 'On exchange' : 'Private'}
              </Badge>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <Meta icon={MapPin} label="Locality" value={project.locality} />
          <Meta
            icon={CalendarClock}
            label="Possession"
            value={project.possessionDate ? formatDateIST(project.possessionDate) : '—'}
          />
          <Meta icon={IndianRupee} label="Price range" value={price ?? '—'} />
          <Meta
            icon={Boxes}
            label="Availability"
            value={`${availableUnits} / ${totalUnits} available`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Meta({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="truncate text-sm font-medium">{value}</span>
    </div>
  );
}
