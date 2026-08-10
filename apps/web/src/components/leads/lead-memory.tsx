'use client';

import { Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Lead, LeadMemoryEntry } from '@/lib/realty-types';

/**
 * What the AI has learned about a buyer — the facts, objections, and promises
 * extracted from their conversations (the lead's JSONB memory fields). Shared by
 * the lead dossier drawer and the standalone lead detail page.
 */
export function LeadMemory({ lead, className }: { lead: Lead; className?: string }) {
  const groups: { title: string; items: LeadMemoryEntry[]; tone: string }[] = [
    { title: 'Facts learned', items: lead.extractedFacts, tone: 'bg-sky-400' },
    { title: 'Objections', items: lead.objections, tone: 'bg-amber-400' },
    { title: 'Promises', items: lead.promises, tone: 'bg-emerald-400' },
  ].filter((g) => g.items.length > 0);

  return (
    <section className={cn('rounded-lg border border-border bg-accent/40 p-3.5', className)}>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Brain className="h-4 w-4 text-primary" />
        What the AI learned
      </h3>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The AI hasn&apos;t extracted anything from this buyer&apos;s conversations yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.title}>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.title}
              </h4>
              <ul className="flex flex-col gap-1">
                {g.items.map((m, i) => (
                  <li key={i} className="flex gap-2 text-xs text-foreground">
                    <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', g.tone)} />
                    <span>{m.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
