'use client';

import { Check, Sparkles, Zap } from 'lucide-react';
import { useSubscription, useUpgradePlan } from '@/hooks/use-settings';
import { usePermissions } from '@/hooks/use-permissions';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils';
import { formatDateIST, formatNumber, paiseToRupees } from '@/lib/format';
import type { SubscriptionPlan, UsageMeter } from '@/lib/feature-types';

const PLANS: {
  plan: SubscriptionPlan;
  priceMonthly: string;
  tagline: string;
  features: string[];
}[] = [
  {
    plan: 'FREE',
    priceMonthly: '₹0',
    tagline: 'Try GoSumo Realty',
    features: ['1 channel', '500 conversations/mo', 'Basic AI replies'],
  },
  {
    plan: 'STARTER',
    priceMonthly: '₹999',
    tagline: 'For solo founders',
    features: ['3 channels', '2,000 conversations/mo', 'HITL review queue', 'Email support'],
  },
  {
    plan: 'GROWTH',
    priceMonthly: '₹2,999',
    tagline: 'For growing teams',
    features: ['All channels', '10,000 conversations/mo', 'Advanced analytics', 'Priority support'],
  },
  {
    plan: 'ENTERPRISE',
    priceMonthly: 'Custom',
    tagline: 'For scale',
    features: [
      'Unlimited everything',
      'Dedicated success manager',
      'SLA & SSO',
      'Custom integrations',
    ],
  },
];

const ORDER: SubscriptionPlan[] = ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'];

export default function BillingPage() {
  const { data, isLoading, isError, error, refetch } = useSubscription();
  const upgrade = useUpgradePlan();
  // POST /billing/upgrade is @Roles(OWNER). Everyone else may read the plan
  // and their usage, but the plan buttons would only 403.
  const { canOwn } = usePermissions();

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const handleUpgrade = (plan: SubscriptionPlan) => {
    upgrade.mutate(plan, {
      onSuccess: (res) => {
        if (res?.checkoutUrl) window.location.href = res.checkoutUrl;
      },
    });
  };

  const currentIndex = ORDER.indexOf(data.plan);

  return (
    <>
      <SettingsCard title="Current plan" description="Your subscription and renewal details.">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-accent/40 p-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <span className="text-lg font-semibold capitalize text-foreground">
                {data.plan.toLowerCase()}
              </span>
              <Badge
                tone={
                  data.status === 'ACTIVE' ? 'success' : data.status === 'TRIAL' ? 'info' : 'danger'
                }
              >
                {data.status === 'PAST_DUE'
                  ? 'Past due'
                  : data.status.charAt(0) + data.status.slice(1).toLowerCase()}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.priceMonthlyPaise > 0
                ? `${paiseToRupees(data.priceMonthlyPaise)}/month`
                : 'Free plan'}
              {data.status === 'TRIAL' && data.trialEndsAt
                ? ` · Trial ends ${formatDateIST(data.trialEndsAt)}`
                : ''}
              {data.currentPeriodEnd ? ` · Renews ${formatDateIST(data.currentPeriodEnd)}` : ''}
            </p>
          </div>
          {canOwn && data.plan !== 'ENTERPRISE' && (
            <Button
              loading={upgrade.isPending}
              onClick={() => handleUpgrade(ORDER[Math.min(currentIndex + 1, ORDER.length - 1)])}
            >
              <Zap className="h-4 w-4" /> Upgrade plan
            </Button>
          )}
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-foreground">Usage this period</p>
          {data.usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage data yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.usage.map((meter) => (
                <UsageBar key={meter.key} meter={meter} />
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Plans</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((p) => {
            const isCurrent = p.plan === data.plan;
            const index = ORDER.indexOf(p.plan);
            return (
              <Card
                key={p.plan}
                className={cn('flex flex-col', isCurrent && 'ring-2 ring-primary')}
              >
                <CardContent className="flex flex-1 flex-col p-4 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold capitalize text-foreground">
                      {p.plan.toLowerCase()}
                    </span>
                    {isCurrent && <Badge tone="primary">Current</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{p.tagline}</p>
                  <p className="mt-3 text-2xl font-bold text-foreground">
                    {p.priceMonthly}
                    {p.priceMonthly.startsWith('₹') && p.plan !== 'FREE' && (
                      <span className="text-sm font-normal text-muted-foreground">/mo</span>
                    )}
                  </p>
                  <ul className="mt-3 flex-1 space-y-1.5">
                    {p.features.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-1.5 text-xs text-muted-foreground"
                      >
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {f}
                      </li>
                    ))}
                  </ul>
                  {canOwn && (
                    <Button
                      variant={
                        isCurrent ? 'outline' : index > currentIndex ? 'primary' : 'secondary'
                      }
                      size="sm"
                      className="mt-4"
                      disabled={isCurrent || upgrade.isPending}
                      onClick={() => handleUpgrade(p.plan)}
                    >
                      {isCurrent ? 'Current plan' : index > currentIndex ? 'Upgrade' : 'Switch'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </>
  );
}

function UsageBar({ meter }: { meter: UsageMeter }) {
  const unlimited = meter.limit == null;
  const pct = unlimited ? 0 : Math.min(100, (meter.used / Math.max(1, meter.limit!)) * 100);
  const tone = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-primary';

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{meter.label}</span>
        <span className="text-muted-foreground">
          {formatNumber(meter.used)}
          {unlimited ? ` ${meter.unit}` : ` / ${formatNumber(meter.limit!)} ${meter.unit}`}
        </span>
      </div>
      {unlimited ? (
        <p className="text-xs text-success">Unlimited</p>
      ) : (
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', tone)}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}
