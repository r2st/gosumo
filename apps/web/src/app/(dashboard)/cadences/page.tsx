'use client';

import { useState } from 'react';
import { Repeat, FileText, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { SegmentedTabs } from '@/components/ui/tabs';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import {
  useCadences,
  useTemplates,
  useUpdateCadence,
  useSetTemplateApproval,
  useSeedCadences,
} from '@/hooks/use-realty';
import {
  CADENCE_TRIGGER_LABELS,
  type Cadence,
  type MessageTemplate,
  type TemplateApprovalStatus,
  type TemplateCategory,
} from '@/lib/realty-types';

const APPROVAL_TONE: Record<TemplateApprovalStatus, BadgeTone> = {
  APPROVED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};
const CATEGORY_TONE: Record<TemplateCategory, BadgeTone> = {
  UTILITY: 'info',
  MARKETING: 'primary',
};

export default function CadencesPage() {
  const [tab, setTab] = useState<'cadences' | 'templates'>('cadences');
  const seed = useSeedCadences();
  // Seeding cadences, toggling one, and approving a template are all
  // undecorated writes — STAFF and above.
  const { canWrite } = usePermissions();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Cadences"
        description="Declarative WhatsApp follow-up sequences and the template library that powers them."
        actions={
          canWrite ? (
            <Button
              variant="outline"
              size="sm"
              loading={seed.isPending}
              onClick={() => seed.mutate()}
            >
              <Sparkles className="h-4 w-4" />
              Install defaults
            </Button>
          ) : null
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-4 lg:p-6">
        <SegmentedTabs
          activeKey={tab}
          onChange={(k) => setTab(k as 'cadences' | 'templates')}
          items={[
            { key: 'cadences', label: 'Cadences' },
            { key: 'templates', label: 'Template library' },
          ]}
        />
        {tab === 'cadences' ? <CadenceList /> : <TemplateLibrary />}
      </div>
    </div>
  );
}

function CadenceList() {
  const { data, isLoading, isError, refetch } = useCadences();
  const toggle = useUpdateCadence();
  const { canWrite } = usePermissions();

  if (isLoading) return <LoadingState label="Loading cadences…" />;
  if (isError) return <ErrorState message="Could not load cadences." onRetry={() => refetch()} />;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Repeat}
        title="No cadences yet"
        description="Install the defaults to get the D1/D3/D7 no-response, post-visit, and dormant reactivation sequences."
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.map((cadence: Cadence) => (
        <Card key={cadence.id}>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="truncate">{cadence.name}</CardTitle>
              <Badge tone="neutral" className="mt-1">
                {CADENCE_TRIGGER_LABELS[cadence.trigger]}
              </Badge>
            </div>
            {canWrite && (
              <Switch
                checked={cadence.isActive}
                onChange={(next) => toggle.mutate({ id: cadence.id, isActive: next })}
              />
            )}
          </CardHeader>
          <CardContent>
            {cadence.description && (
              <p className="mb-3 text-sm text-muted-foreground">{cadence.description}</p>
            )}
            <ol className="space-y-2">
              {cadence.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-3 text-sm">
                  <span className="flex h-7 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                    D+{step.dayOffset}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{step.templateName}</span>
                  {step.stopOn.length > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      stop: {step.stopOn.join(', ').toLowerCase()}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TemplateLibrary() {
  const { data, isLoading, isError, refetch } = useTemplates();
  const setApproval = useSetTemplateApproval();
  const { canWrite } = usePermissions();

  if (isLoading) return <LoadingState label="Loading templates…" />;
  if (isError) return <ErrorState message="Could not load templates." onRetry={() => refetch()} />;
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No templates yet"
        description="Install the defaults to load the 12 pre-built real-estate WhatsApp templates."
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.map((tpl: MessageTemplate) => (
        <Card key={tpl.id}>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <CardTitle className="truncate font-mono text-sm">{tpl.name}</CardTitle>
            <div className="flex shrink-0 gap-1">
              <Badge tone={CATEGORY_TONE[tpl.category]}>{tpl.category}</Badge>
              <Badge tone={APPROVAL_TONE[tpl.approvalStatus]}>{tpl.approvalStatus}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{tpl.body}</p>
            {tpl.approvalStatus !== 'APPROVED' && canWrite && (
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="success"
                  loading={setApproval.isPending}
                  onClick={() => setApproval.mutate({ id: tpl.id, approvalStatus: 'APPROVED' })}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setApproval.mutate({ id: tpl.id, approvalStatus: 'REJECTED' })}
                >
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
