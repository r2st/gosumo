'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Building2, ChevronRight, ClipboardList, Mail, MapPin, Phone } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { BltcQualBars } from '@/components/leads/bltc-bars';
import { LeadActions } from '@/components/leads/lead-actions';
import { LeadActivityTimeline } from '@/components/leads/lead-activity-timeline';
import { LeadMatchedUnits } from '@/components/leads/lead-matched-units';
import { LeadMemory } from '@/components/leads/lead-memory';
import { QualScoreGauge } from '@/components/leads/qual-score-gauge';
import { useLead } from '@/hooks/use-realty';
import { sourceLabel, sourceTone, TEMPERATURE_TONE } from '@/lib/realty-ui';
import { STAGE_LABELS, type Lead } from '@/lib/realty-types';

export default function LeadDetailPage() {
  const params = useParams<{ leadId: string }>();
  const leadId = params?.leadId ?? null;
  const router = useRouter();
  const { data: lead, isLoading, isError, refetch } = useLead(leadId);

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 border-b border-border bg-card px-4 py-3 text-sm lg:px-6"
      >
        <Link href="/leads" className="text-muted-foreground hover:text-foreground">
          Leads
        </Link>
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium text-foreground">
          {lead?.name ?? (isLoading ? 'Loading…' : 'Lead')}
        </span>
      </nav>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {isLoading ? (
          <LoadingState label="Loading lead…" />
        ) : isError ? (
          <ErrorState message="Could not load this lead." onRetry={() => refetch()} />
        ) : !lead ? (
          <EmptyState
            icon={ClipboardList}
            title="Lead not found"
            description="This lead may have been removed."
            action={
              <button
                onClick={() => router.push('/leads')}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                Back to pipeline
              </button>
            }
          />
        ) : (
          <LeadDetail lead={lead} />
        )}
      </div>
    </div>
  );
}

function LeadDetail({ lead }: { lead: Lead }) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      {/* Header */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <Avatar name={lead.name ?? 'Unknown buyer'} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold tracking-tight">
                {lead.name ?? 'Unknown buyer'}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge tone={TEMPERATURE_TONE[lead.temperature]}>{lead.temperature}</Badge>
                <Badge tone="primary">{STAGE_LABELS[lead.stage]}</Badge>
                <Badge tone={sourceTone(lead)}>{sourceLabel(lead)}</Badge>
                {lead.optOut && <Badge tone="danger">Opted out</Badge>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <a
                  href={`tel:${lead.whatsappPhone}`}
                  className="flex min-w-0 items-center gap-1.5 hover:text-primary"
                >
                  <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{lead.whatsappPhone}</span>
                </a>
                {lead.email && (
                  <a
                    href={`mailto:${lead.email}`}
                    className="flex min-w-0 items-center gap-1.5 hover:text-primary"
                  >
                    <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-all">{lead.email}</span>
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="shrink-0 self-center">
            <QualScoreGauge score={lead.qualScore} />
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardContent className="p-4">
          <LeadActions lead={lead} />
        </CardContent>
      </Card>

      {/* Two-column body. grid-cols-1 (minmax(0,1fr)) keeps the column bounded to the
          viewport on mobile — without it the implicit auto column grows to the widest
          nowrap child inside the scroll container and pushes content off-screen. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Requirement (BLTC)</CardTitle>
            </CardHeader>
            <CardContent>
              <BltcQualBars bltc={lead.bltc} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Building2 className="h-4 w-4" />
                Best-matched units
              </CardTitle>
            </CardHeader>
            <CardContent>
              <LeadMatchedUnits lead={lead} />
            </CardContent>
          </Card>

          <LeadMemory lead={lead} />
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                Activity timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <LeadActivityTimeline lead={lead} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
