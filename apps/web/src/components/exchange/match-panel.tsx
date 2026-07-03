'use client';

import { useState } from 'react';
import { Building2, Sparkles, Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { LoadingState, EmptyState } from '@/components/ui/states';
import { paiseToCompactRupees } from '@/lib/format';
import { useLeads, useExchangeMatch } from '@/hooks/use-realty';
import { scoreTone, shortBusinessId } from '@/lib/exchange-ui';
import type { ExchangeMatch } from '@/lib/realty-types';

function MatchRow({ m }: { m: ExchangeMatch }) {
  const Icon = m.sourceType === 'UNIT' ? Building2 : Store;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground">
              {m.config} · {m.locality}
            </span>
            {m.projectName && <span className="text-sm text-muted-foreground">{m.projectName}</span>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{paiseToCompactRupees(m.askingPricePaise)}</p>
          {m.reasons.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {m.reasons.map((r) => (
                <li key={r}>
                  <Badge tone="neutral">{r}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            counterparty {shortBusinessId(m.ownerBusinessId)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <Badge tone={scoreTone(m.blendedScore)}>match {m.blendedScore}</Badge>
          <span className="text-xs text-muted-foreground">fit {m.fitScore}</span>
          <span className="text-xs text-muted-foreground">reliability {Math.round(m.reliabilityScore)}</span>
        </div>
      </div>
    </Card>
  );
}

/**
 * Pick a lead, see the network supply the exchange would route it to — ranked by
 * BLTC fit blended with counterparty reliability, with an optional AI rationale.
 */
export function ExchangeMatchPanel() {
  const [leadId, setLeadId] = useState<string>('');
  const [ai, setAi] = useState(false);
  const leadsQ = useLeads({ limit: 50 });
  const leads = leadsQ.data?.data ?? [];
  const matchQ = useExchangeMatch(leadId || null, { aiRationale: ai });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Lead</span>
          <div className="min-w-[240px]">
            <Select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              options={[
                { value: '', label: 'Select a lead…' },
                ...leads.map((l) => ({
                  value: l.id,
                  label: `${l.name ?? l.whatsappPhone} · ${l.bltc.config ?? 'any'} · ${l.bltc.localities[0] ?? 'any'}`,
                })),
              ]}
            />
          </div>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} className="h-4 w-4" />
          <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
          AI rationale
        </label>
      </div>

      {!leadId ? (
        <EmptyState
          icon={Building2}
          title="Pick a lead to find network matches"
          description="The exchange surfaces verified supply from other members, ranked by fit and their reliability."
        />
      ) : matchQ.isLoading ? (
        <LoadingState label="Searching the network…" />
      ) : !matchQ.data || matchQ.data.matches.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No network matches yet"
          description="No other member has matching EXCHANGE-visible supply for this lead's BLTC profile right now."
        />
      ) : (
        <div className="space-y-3">
          {matchQ.data.aiRationale && (
            <Card className="flex gap-2 border-primary/30 bg-primary/5 p-4 text-sm text-foreground">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>{matchQ.data.aiRationale}</p>
            </Card>
          )}
          {matchQ.data.matches.map((m) => (
            <MatchRow key={`${m.sourceType}-${m.listingId}`} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
