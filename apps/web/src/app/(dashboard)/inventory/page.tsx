'use client';

import { Building2, MapPin, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { useProjects } from '@/hooks/use-realty';
import { paiseToCompactRupees } from '@/lib/format';
import type { ProjectStatus } from '@/lib/realty-types';

const STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  PRELAUNCH: 'info',
  UC: 'warning',
  RTM: 'success',
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  PRELAUNCH: 'Pre-launch',
  UC: 'Under construction',
  RTM: 'Ready to move',
};

export default function InventoryPage() {
  const projectsQ = useProjects();
  const projects = projectsQ.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inventory"
        description="Verified projects and units — the only ground truth your AI is allowed to quote."
      />

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {projectsQ.isLoading ? (
          <LoadingState label="Loading inventory…" />
        ) : projectsQ.isError ? (
          <ErrorState message="Could not load projects." onRetry={() => projectsQ.refetch()} />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No projects yet"
            description="Add a verified project with its RERA number and fact sheet so the AI can match buyers to real inventory."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const band =
                p.priceBandMinPaise != null || p.priceBandMaxPaise != null
                  ? `${paiseToCompactRupees(p.priceBandMinPaise ?? p.priceBandMaxPaise)}${
                      p.priceBandMaxPaise != null && p.priceBandMinPaise != null
                        ? `–${paiseToCompactRupees(p.priceBandMaxPaise)}`
                        : '+'
                    }`
                  : null;
              return (
                <Card key={p.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{p.name}</p>
                        {p.developer && (
                          <p className="truncate text-xs text-muted-foreground">{p.developer}</p>
                        )}
                      </div>
                      <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </div>

                    <p className="mt-3 flex items-center gap-1 text-sm text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5" />
                      {p.locality}
                    </p>

                    {band && <p className="mt-1 text-sm font-medium">{band}</p>}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {p.reraNumber && (
                        <Badge tone="success" className="gap-1">
                          <ShieldCheck className="h-3 w-3" />
                          RERA {p.reraNumber}
                        </Badge>
                      )}
                      {p.networkVisibility === 'EXCHANGE' && <Badge tone="primary">Exchange</Badge>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
