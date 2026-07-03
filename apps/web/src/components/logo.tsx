import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={cn('h-8 w-8', className)}
      role="img"
      aria-label="GoSumo"
    >
      <defs>
        <linearGradient id="gosumo-mark" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366F1" />
          <stop offset="0.55" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" ry="116" fill="url(#gosumo-mark)" />
      <g fill="none" stroke="#FFFFFF" strokeWidth="66" strokeLinecap="round" strokeLinejoin="round">
        {/* G loop with an integrated gabled rooftop — a property silhouette that still reads as the letter */}
        <path d="M369 186 L256 84 L143 186 A140 140 0 1 0 375 342" />
        {/* horizontal spur bar of the G */}
        <path d="M250 268 L375 268 L375 342" />
      </g>
    </svg>
  );
}

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark className="h-8 w-8 shadow-sm rounded-[0.45rem]" />
      {showWordmark && (
        <span className="text-lg font-extrabold tracking-tight text-foreground">GoSumo</span>
      )}
    </div>
  );
}
