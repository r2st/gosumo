'use client';

import { Phone, TrendingUp } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { paiseToCompactRupees } from '@/lib/format';
import type { Lead, LeadTemperature } from '@/lib/realty-types';

const TEMP_TONE: Record<LeadTemperature, BadgeTone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'info',
  JUNK: 'neutral',
};

function budgetLabel(lead: Lead): string | null {
  const { budgetMinPaise, budgetMaxPaise } = lead.bltc;
  if (budgetMinPaise == null && budgetMaxPaise == null) return null;
  if (budgetMinPaise != null && budgetMaxPaise != null) {
    return `${paiseToCompactRupees(budgetMinPaise)}–${paiseToCompactRupees(budgetMaxPaise)}`;
  }
  return paiseToCompactRupees(budgetMaxPaise ?? budgetMinPaise);
}

export function LeadCard({ lead }: { lead: Lead }) {
  const budget = budgetLabel(lead);
  const bits = [lead.bltc.config, lead.bltc.localities[0], budget].filter(Boolean);

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm transition hover:border-accent">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{lead.name ?? 'Unknown buyer'}</p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Phone className="h-3 w-3" />
            {lead.whatsappPhone}
          </p>
        </div>
        <Badge tone={TEMP_TONE[lead.temperature]}>{lead.temperature}</Badge>
      </div>

      {bits.length > 0 && (
        <p className="mt-2 truncate text-xs text-muted-foreground">{bits.join(' · ')}</p>
      )}

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 font-medium text-muted-foreground">
          <TrendingUp className="h-3 w-3" />
          Score {lead.qualScore}
        </span>
        <span className="text-muted-foreground">{lead.source}</span>
      </div>
    </div>
  );
}
