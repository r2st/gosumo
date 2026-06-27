import { cn } from '@/lib/utils';

export function Logo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <span className="text-base font-black tracking-tight">G</span>
      </div>
      {showWordmark && <span className="text-lg font-bold tracking-tight">GoSumo</span>}
    </div>
  );
}
