'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  CalendarPlus,
  FileText,
  Hand,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  PhoneCall,
} from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/states';
import { BltcQualBars } from '@/components/leads/bltc-bars';
import { LeadMemory } from '@/components/leads/lead-memory';
import { LeadVisitHistory } from '@/components/leads/lead-visit-history';
import { useMatchForLead } from '@/hooks/use-realty';
import { paiseToCompactRupees } from '@/lib/format';
import { cn } from '@/lib/utils';
import { matchBorder, matchTone, sourceLabel, sourceTone, TEMPERATURE_TONE } from '@/lib/realty-ui';
import { STAGE_LABELS, type Lead } from '@/lib/realty-types';
import { buildWhatsAppLink } from '@/lib/whatsapp-link';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * Lead dossier — a wide split slide-over. Left: who the buyer is (contact,
 * BLTC qualification bars, what the AI has learned). Right: the best-matched
 * verified units ranked by fit, plus quick actions.
 */
export function LeadDossier({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const match = useMatchForLead();
  const runMatch = match.mutate;
  // See LeadMatchedUnits: matching is a POST, so a VIEWER cannot run it.
  const { canWrite } = usePermissions();

  useEffect(() => {
    if (lead && canWrite) runMatch({ id: lead.id, limit: 6 });
  }, [lead, runMatch, canWrite]);

  if (!lead) return null;

  return (
    <Drawer
      open={!!lead}
      onClose={onClose}
      title={lead.name ?? 'Unknown buyer'}
      description={`${STAGE_LABELS[lead.stage]} · Qualification score ${lead.qualScore}`}
      className="max-w-4xl"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.05fr]">
        <LeftPanel lead={lead} />
        <RightPanel lead={lead} match={match} />
      </div>
    </Drawer>
  );
}

function LeftPanel({ lead }: { lead: Lead }) {
  return (
    <div className="flex flex-col gap-5">
      {/* Contact header */}
      <div className="flex items-start gap-3">
        <Avatar name={lead.name ?? 'Unknown buyer'} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TEMPERATURE_TONE[lead.temperature]}>{lead.temperature}</Badge>
            <Badge tone={sourceTone(lead)}>{sourceLabel(lead)}</Badge>
            {lead.optOut && <Badge tone="danger">Opted out</Badge>}
          </div>
          <a
            href={`tel:${lead.whatsappPhone}`}
            className="mt-2 flex min-w-0 items-center gap-1.5 text-sm hover:text-primary"
          >
            <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{lead.whatsappPhone}</span>
          </a>
          <a
            href={buildWhatsAppLink(lead.whatsappPhone)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1.5 text-sm text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
          >
            <MessageCircle className="h-3.5 w-3.5 shrink-0" />
            <span>Message on WhatsApp</span>
          </a>
          {lead.email && (
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm">
              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-all">{lead.email}</span>
            </p>
          )}
        </div>
      </div>

      {/* BLTC qualification */}
      <section>
        <h3 className="mb-3 text-sm font-semibold">Requirement (BLTC)</h3>
        <BltcQualBars bltc={lead.bltc} />
      </section>

      {/* AI memory */}
      <LeadMemory lead={lead} />

      <LeadVisitHistory leadId={lead.id} />
    </div>
  );
}

function RightPanel({ lead, match }: { lead: Lead; match: ReturnType<typeof useMatchForLead> }) {
  const router = useRouter();
  const units = match.data ?? [];
  // The quick actions all lead to write surfaces; "Call" is a tel: link and
  // stays available to everyone.
  const { canWrite } = usePermissions();

  return (
    <div className="flex flex-col gap-4">
      {/* Quick actions */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Quick actions</h3>
        <div className="grid grid-cols-2 gap-2">
          {canWrite && (
            <>
              <Button size="sm" variant="primary" onClick={() => router.push('/sitevisits')}>
                <CalendarPlus className="h-4 w-4" />
                Book visit
              </Button>
              <Button size="sm" variant="outline" onClick={() => router.push('/inventory')}>
                <FileText className="h-4 w-4" />
                Send brochure
              </Button>
            </>
          )}
          <a
            href={`tel:${lead.whatsappPhone}`}
            className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <PhoneCall className="h-4 w-4" />
            Call
          </a>
          <a
            href={buildWhatsAppLink(lead.whatsappPhone)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-green-600 bg-green-600 px-3 text-xs font-medium text-white transition-colors hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-1 dark:border-green-500 dark:bg-green-600 dark:hover:bg-green-700"
          >
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </a>
          {canWrite && (
            <Button size="sm" variant="secondary" onClick={() => router.push('/conversations')}>
              <Hand className="h-4 w-4" />
              Takeover
            </Button>
          )}
        </div>
      </section>

      {/* Best-matched units */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Building2 className="h-4 w-4" />
          Best-matched units
        </h3>
        {match.isPending ? (
          <div className="py-6">
            <Spinner />
          </div>
        ) : match.isError ? (
          <p className="py-4 text-xs text-muted-foreground">Could not compute matches.</p>
        ) : units.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
            No verified units match this buyer&apos;s requirement yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {units.map((u) => (
              <li
                key={u.unitId}
                className={cn(
                  'rounded-lg border border-l-4 border-border bg-card p-3 shadow-sm',
                  matchBorder(u.fitScore),
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{u.projectName}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {u.config} · {u.locality}
                    </p>
                  </div>
                  <Badge tone={matchTone(u.fitScore)} className="shrink-0">
                    {u.fitScore}% match
                  </Badge>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {paiseToCompactRupees(u.allInPricePaise)}
                  </span>
                  {u.reasons.length > 0 && (
                    <span
                      className="truncate text-[11px] text-muted-foreground"
                      title={u.reasons.join(' · ')}
                    >
                      {u.reasons[0]}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
