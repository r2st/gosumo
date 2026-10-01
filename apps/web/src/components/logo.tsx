import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={cn('h-8 w-8', className)}
      role="img"
      aria-label="DoAide Inbox"
    >
      <rect width="512" height="512" rx="116" ry="116" fill="#F0B429" />
      <g fill="none" stroke="#0A0A0B" strokeWidth="66" strokeLinecap="round" strokeLinejoin="round">
        <path d="M369 186 L256 84 L143 186 A140 140 0 1 0 375 342" />
        <path d="M250 268 L375 268 L375 342" />
      </g>
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
      <LogoMark className="h-8 w-8 shadow-sm rounded-[0.45rem]" />
      {showWordmark && (
        <div className="flex flex-col">
          <span className="font-heading text-lg tracking-tight text-foreground">
            DoAide <span className="italic text-primary">Inbox</span>
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
