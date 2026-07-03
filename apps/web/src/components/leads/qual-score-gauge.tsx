import { cn } from '@/lib/utils';

/** Colour band for a 0–100 qualification score: green ≥70, amber ≥40, else slate. */
function scoreColor(score: number): string {
  if (score >= 70) return 'text-emerald-500';
  if (score >= 40) return 'text-amber-500';
  return 'text-slate-400';
}

/**
 * Compact radial gauge for a lead's 0–100 qualification score. Pure SVG so it
 * inherits the current theme's text/muted colours and adapts to dark mode.
 */
export function QualScoreGauge({
  score,
  size = 96,
  className,
}: {
  score: number;
  size?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Qualification score ${clamped} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          className={cn('transition-all', scoreColor(clamped), 'stroke-current')}
        />
      </svg>
      <div className="absolute flex flex-col items-center leading-none">
        <span className={cn('text-xl font-bold tracking-tight', scoreColor(clamped))}>{clamped}</span>
        <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Score
        </span>
      </div>
    </div>
  );
}
