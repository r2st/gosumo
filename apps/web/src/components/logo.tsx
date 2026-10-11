import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('h-8 w-8', className)}
      role="img"
      aria-label="DoAide Desk"
    >
      <rect width="32" height="32" rx="8" fill="#0D9488" />
      <text x="16" y="22" textAnchor="middle" fill="#FFFFFF" fontSize="18" fontWeight="700" fontFamily="Inter, system-ui, sans-serif">D</text>
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
          <span className="font-sans text-lg font-bold tracking-tight">
            <span className="text-primary">DoAide</span>
            <span className="text-muted-foreground mx-1.5 font-light">|</span>
            <span className="text-foreground">Desk</span>
          </span>
          {showParentBrand && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              A DoAide Product
            </span>
          )}
        </div>
      )}
    </div>
  );
}
