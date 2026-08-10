'use client';

import Link from 'next/link';
import { Flame, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BltcCompletionBar } from '@/components/leads/bltc-bars';
import { cn } from '@/lib/utils';
import { budgetLabel, sourceLabel, sourceTone, TEMPERATURE_BORDER } from '@/lib/realty-ui';
import type { Lead } from '@/lib/realty-types';

/**
 * A kanban lead card. Pass `href` to navigate to the lead's detail page (renders
 * a real anchor — supports open-in-new-tab), or `onClick` for an in-place action
 * such as opening the quick-view dossier.
 */
export function LeadCard({ lead, href, onClick }: { lead: Lead; href?: string; onClick?: () => void }) {
  const budget = budgetLabel(lead.bltc);
  const summary = [lead.bltc.config, lead.bltc.localities[0], budget].filter(Boolean).join(' · ');
  const isHot = lead.temperature === 'HOT';

  const className = cn(
    'block rounded-lg border border-l-4 border-border bg-card p-3 shadow-sm transition',
    'hover:border-accent hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    TEMPERATURE_BORDER[lead.temperature],
    (href || onClick) && 'cursor-pointer',
  );

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{lead.name ?? 'Unknown buyer'}</p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Phone className="h-3 w-3 shrink-0" />
            <span className="truncate">{lead.whatsappPhone}</span>
          </p>
        </div>
        {isHot && (
          <Badge tone="danger" className="shrink-0 gap-1">
            <Flame className="h-3 w-3" />
            HOT
          </Badge>
        )}
      </div>

      {summary && <p className="mt-2 truncate text-xs text-muted-foreground">{summary}</p>}

      <BltcCompletionBar bltc={lead.bltc} className="mt-2.5" />

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <Badge tone={sourceTone(lead)}>{sourceLabel(lead)}</Badge>
        <span className="text-[11px] font-medium text-muted-foreground">Score {lead.qualScore}</span>
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      className={className}
    >
      {body}
    </div>
  );
}
