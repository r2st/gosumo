'use client';

import Link from 'next/link';
import { ArrowRight, IndianRupee } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { paiseToCompactRupees, formatDateIST } from '@/lib/format';
import { SYNDICATION_STATE_LABELS, type Syndication } from '@/lib/realty-types';
import { SYNDICATION_STATE_TONE, SETTLEMENT_TONE, shortBusinessId } from '@/lib/exchange-ui';

/** A single syndication row/card — links through to the detail view. */
export function SyndicationCard({ syndication: s }: { syndication: Syndication }) {
  const split = s.splitTerms;
  const splitLabel = `${split.originatorPct}/${split.counterpartyPct}${
    split.developerPct ? `/${split.developerPct}` : ''
  }`;

  return (
    <Link href={`/exchange/${s.id}`} className="block">
      <Card className="p-4 transition-colors hover:border-primary/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={SYNDICATION_STATE_TONE[s.state]}>{SYNDICATION_STATE_LABELS[s.state]}</Badge>
              <Badge tone={SETTLEMENT_TONE[s.settlementState]}>{s.settlementState.toLowerCase()}</Badge>
              <span className="text-xs text-muted-foreground">Split {splitLabel}</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-sm text-foreground">
              <span className="font-mono text-xs text-muted-foreground">{shortBusinessId(s.fromBusinessId)}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">{shortBusinessId(s.toBusinessId)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            {s.state === 'CLOSED' ? (
              <div className="flex items-center justify-end gap-0.5 text-sm font-semibold text-foreground">
                <IndianRupee className="h-3.5 w-3.5" aria-hidden />
                {paiseToCompactRupees(s.commissionPoolPaise).replace('₹', '')}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{formatDateIST(s.createdAt)}</span>
            )}
            {s.state === 'CLOSED' && (
              <div className="text-xs text-muted-foreground">
                fee {paiseToCompactRupees(s.platformFeePaise)}
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}
