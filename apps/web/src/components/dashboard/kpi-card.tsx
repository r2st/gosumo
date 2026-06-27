import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  iconClassName?: string;
  hint?: string;
  trend?: number; // percentage; positive = up
  loading?: boolean;
}

export function KpiCard({ label, value, icon: Icon, iconClassName, hint, trend, loading }: KpiCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-24" />
          ) : (
            <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
          )}
          {hint && !loading && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          {typeof trend === 'number' && !loading && (
            <div
              className={cn(
                'mt-2 inline-flex items-center gap-1 text-xs font-medium',
                trend >= 0 ? 'text-emerald-600' : 'text-rose-600',
              )}
            >
              {trend >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {Math.abs(trend).toFixed(1)}%
            </div>
          )}
        </div>
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', iconClassName ?? 'bg-accent text-accent-foreground')}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}
