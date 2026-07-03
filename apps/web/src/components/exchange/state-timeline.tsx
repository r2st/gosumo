'use client';

import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SYNDICATION_FLOW,
  SYNDICATION_STATE_LABELS,
  type SyndicationState,
} from '@/lib/realty-types';

/**
 * Horizontal state timeline for a syndication. Walks the happy-path flow
 * (OFFERED → ACCEPTED → VISIT → CLOSED) and marks how far the deal got. EXPIRED
 * and DISPUTED are off-path terminal states rendered as a distinct end node.
 */
export function SyndicationTimeline({ state }: { state: SyndicationState }) {
  const offPath = state === 'EXPIRED' || state === 'DISPUTED';
  const reachedIndex = SYNDICATION_FLOW.indexOf(state);

  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Syndication progress">
      {SYNDICATION_FLOW.map((step, i) => {
        // Once off-path, everything after the last reached happy-path node is inert.
        const done = !offPath && reachedIndex >= i;
        const current = !offPath && reachedIndex === i;
        return (
          <li key={step} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold',
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground',
                  current && 'ring-2 ring-primary/30',
                )}
              >
                {done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-sm font-medium',
                  done ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {SYNDICATION_STATE_LABELS[step]}
              </span>
            </div>
            {i < SYNDICATION_FLOW.length - 1 && (
              <span
                className={cn('h-px w-6', done && reachedIndex > i ? 'bg-primary' : 'bg-border')}
                aria-hidden
              />
            )}
          </li>
        );
      })}

      {offPath && (
        <li className="flex items-center gap-2">
          <span className="h-px w-6 bg-border" aria-hidden />
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold',
                state === 'DISPUTED'
                  ? 'border-danger bg-danger/10 text-danger'
                  : 'border-border bg-muted text-muted-foreground',
              )}
            >
              <X className="h-4 w-4" aria-hidden />
            </span>
            <span className="text-sm font-medium text-foreground">
              {SYNDICATION_STATE_LABELS[state]}
            </span>
          </span>
        </li>
      )}
    </ol>
  );
}
