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
      <g fill="none" stroke="#FFFFFF" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round">
        <path d="M347.93 333.13 A120 120 0 1 1 347.93 178.87" />
        <path d="M256 256 L347.93 256 L347.93 333.13" />
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
