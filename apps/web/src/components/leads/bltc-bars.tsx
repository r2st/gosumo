import { cn } from '@/lib/utils';
import { BLTC_FILL, bltcCompletion, bltcComponents } from '@/lib/realty-ui';
import type { BltcProfile } from '@/lib/realty-types';

/**
 * Compact BLTC (Budget · Location · Timeline · Config) completion bar for lead
 * cards — the primary at-a-glance signal of how well-qualified a lead is.
 * Green when all four are captured, amber while partial.
 */
export function BltcCompletionBar({ bltc, className }: { bltc: BltcProfile; className?: string }) {
  const { filled, total, pct, state } = bltcCompletion(bltc);
  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>BLTC</span>
        <span>
          {filled}/{total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', BLTC_FILL[state])}
          style={{ width: `${Math.max(pct, filled > 0 ? 8 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Detailed per-dimension BLTC bars for the lead dossier — one row each for
 * Budget, Location, Timeline, Config, with the captured value beside it.
 */
export function BltcQualBars({ bltc }: { bltc: BltcProfile }) {
  const parts = bltcComponents(bltc);
  return (
    <div className="flex flex-col gap-3">
      {parts.map((p) => (
        <div key={p.key}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold',
                  p.filled ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
                )}
              >
                {p.key}
              </span>
              <span className="font-medium text-muted-foreground">{p.label}</span>
            </span>
            <span
              className={cn(
                'min-w-0 truncate text-right',
                p.filled ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
              title={p.value}
            >
              {p.value}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', p.filled ? 'bg-emerald-500' : 'bg-slate-200')}
              style={{ width: p.filled ? '100%' : '10%' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
