'use client';

import { Phone, Mail } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { paiseToCompactRupees } from '@/lib/format';
import { LeadVisitHistory } from '@/components/leads/lead-visit-history';
import { STAGE_LABELS, type Lead } from '@/lib/realty-types';

function budget(lead: Lead): string {
  const { budgetMinPaise, budgetMaxPaise } = lead.bltc;
  if (budgetMinPaise == null && budgetMaxPaise == null) return '—';
  if (budgetMinPaise != null && budgetMaxPaise != null) {
    return `${paiseToCompactRupees(budgetMinPaise)}–${paiseToCompactRupees(budgetMaxPaise)}`;
  }
  return paiseToCompactRupees(budgetMaxPaise ?? budgetMinPaise);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function MemoryList({ title, items }: { title: string; items: { text: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="flex flex-col gap-1">
        {items.map((m, i) => (
          <li key={i} className="text-xs text-foreground">
            • {m.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Slide-over showing a lead's profile, BLTC, memory, and visit history. */
export function LeadDetailDrawer({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  if (!lead) return null;
  const { bltc } = lead;

  return (
    <Drawer
      open={!!lead}
      onClose={onClose}
      title={lead.name ?? 'Unknown buyer'}
      description={`${STAGE_LABELS[lead.stage]} · Score ${lead.qualScore}`}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          <Badge tone="info">{lead.temperature}</Badge>
          <Badge tone="neutral">{lead.source}</Badge>
          {lead.optOut && <Badge tone="danger">Opted out</Badge>}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1 flex items-center gap-1.5 text-sm">
            <Phone className="h-3.5 w-3.5 text-muted-foreground" />
            {lead.whatsappPhone}
          </p>
          {lead.email && (
            <p className="flex items-center gap-1.5 text-sm">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              {lead.email}
            </p>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold">Requirement (BLTC)</h3>
          <Row label="Budget" value={budget(lead)} />
          <Row label="Location" value={bltc.localities.length ? bltc.localities.join(', ') : '—'} />
          <Row label="Timeline" value={bltc.timelineMonths != null ? `${bltc.timelineMonths} months` : '—'} />
          <Row label="Config" value={bltc.config ?? '—'} />
          <Row label="Purpose" value={bltc.purpose ?? '—'} />
          <Row label="Financing" value={bltc.financing ?? '—'} />
        </div>

        {(lead.extractedFacts.length > 0 ||
          lead.objections.length > 0 ||
          lead.promises.length > 0) && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Memory</h3>
            <MemoryList title="Facts" items={lead.extractedFacts} />
            <MemoryList title="Objections" items={lead.objections} />
            <MemoryList title="Promises" items={lead.promises} />
          </div>
        )}

        <LeadVisitHistory leadId={lead.id} />
      </div>
    </Drawer>
  );
}
