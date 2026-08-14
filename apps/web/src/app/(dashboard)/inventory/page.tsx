'use client';

import { Building2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { InventoryCard } from '@/components/inventory/inventory-card';
import { useProjects } from '@/hooks/use-realty';

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
          <ErrorState message="Could not load projects." error={projectsQ.error} onRetry={() => projectsQ.refetch()} />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No projects yet"
            description="Add a verified project with its RERA number and fact sheet so the AI can match buyers to real inventory."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((p) => (
              <InventoryCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
