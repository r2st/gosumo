import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('h-8 w-8', className)}
      role="img"
      aria-label="DoAide Desk"
    >
      <line x1="16" y1="6" x2="16" y2="2" stroke="#F0B429" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="1.5" r="1.5" fill="#F0B429" />
      <rect x="5" y="6" width="22" height="17" rx="5" fill="#F0B429" />
      <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <circle cx="11.5" cy="12.5" r="1" fill="#F7CC5F" />
      <circle cx="21.5" cy="12.5" r="1" fill="#F7CC5F" />
      <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="1" y="10" width="4" height="5" rx="2" fill="#D4A017" />
      <rect x="27" y="10" width="4" height="5" rx="2" fill="#D4A017" />
    </svg>
  );
}

export function Logo({
  className,
  showWordmark = true,
  showParentBrand = false,
}: {
  className?: string;
  showWordmark?: boolean;
  showParentBrand?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark className="h-8 w-8" />
      {showWordmark && (
        <div className="flex flex-col">
          <span className="font-heading text-lg tracking-tight text-foreground">
            DoAide <span className="italic text-primary">Desk</span>
          </span>
          {showParentBrand && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              AI-powered
            </span>
          )}
        </div>
      )}
    </div>
  );
}
