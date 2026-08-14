'use client';

import { Globe, Lock } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useUpdateProject } from '@/hooks/use-realty';
import { useToast } from '@/providers/toast-provider';
import { cn } from '@/lib/utils';
import type { RealtyProject } from '@/lib/realty-types';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * PRIVATE ↔ EXCHANGE visibility control. PRIVATE keeps a project inside the
 * brokerage; EXCHANGE exposes it to the co-broking network for matching.
 */
export function InventoryVisibilityToggle({ project }: { project: RealtyProject }) {
  const toast = useToast();
  const update = useUpdateProject();
  // Listing a project on the exchange patches it — STAFF and above. Read-only
  // roles still see whether it is listed.
  const { canWrite } = usePermissions();
  const onExchange = project.networkVisibility === 'EXCHANGE';

  const toggle = (next: boolean) => {
    const networkVisibility = next ? 'EXCHANGE' : 'PRIVATE';
    update.mutate(
      { id: project.id, networkVisibility },
      {
        onSuccess: () =>
          toast.success(
            next ? 'Now visible on the co-broking exchange.' : 'Now private to your brokerage.',
            { title: 'Visibility updated' },
          ),
        onError: () => toast.error('Could not change visibility. Please try again.'),
      },
    );
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            onExchange ? 'bg-indigo-50 text-indigo-600' : 'bg-muted text-muted-foreground',
          )}
        >
          {onExchange ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        </span>
        <div>
          <p className="text-sm font-medium">{onExchange ? 'On the exchange' : 'Private'}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {onExchange
              ? 'Partner brokers can match their buyers to this project.'
              : 'Only your team can see and quote this project.'}
          </p>
        </div>
      </div>
      {canWrite && <Switch checked={onExchange} onChange={toggle} disabled={update.isPending} />}
    </div>
  );
}
