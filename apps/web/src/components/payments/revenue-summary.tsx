'use client';

import { CheckCircle2, IndianRupee, Receipt, RotateCcw } from 'lucide-react';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePaymentStats } from '@/hooks/use-payments';
import { formatNumber, formatRatioPct, paiseToCompactRupees, paiseToRupees } from '@/lib/format';

export function RevenueSummary() {
  const { data, isLoading } = usePaymentStats();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiCard
        label="Total revenue"
        value={paiseToCompactRupees(data.totalRevenue)}
        icon={IndianRupee}
        iconClassName="bg-emerald-50 text-emerald-600"
        hint={`${formatNumber(data.totalTransactions)} transactions`}
      />
      <KpiCard
        label="Success rate"
        value={formatRatioPct(data.successRate)}
        icon={CheckCircle2}
        iconClassName="bg-sky-50 text-sky-600"
      />
      <KpiCard
        label="Avg transaction"
        value={paiseToRupees(data.avgTransactionValue)}
        icon={Receipt}
        iconClassName="bg-violet-50 text-violet-600"
      />
      <KpiCard
        label="Refunded"
        value={paiseToCompactRupees(data.refundedAmount)}
        icon={RotateCcw}
        iconClassName="bg-amber-50 text-amber-600"
        hint={`${formatNumber(data.refundCount)} refunds`}
      />
    </div>
  );
}
