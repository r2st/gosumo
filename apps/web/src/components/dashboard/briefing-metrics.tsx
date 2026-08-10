'use client';

import Link from 'next/link';
import { CalendarCheck, CheckSquare, Clock, Flame, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMorningBriefing } from '@/hooks/use-realty';

interface Metric {
  label: string;
  value: number;
  icon: LucideIcon;
  color: string;
  iconBg: string;
  href: string;
}

/**
 * The morning-briefing metric row — four clean white cards with large accent
 * numbers that open the broker's day: today's visits, hot leads, follow-ups
 * due, and AI drafts awaiting approval. Backed by GET /realty/broker/briefing.
 */
export function BriefingMetrics() {
  const { data, isLoading, isError } = useMorningBriefing();

  if (isError) return null; // realty may not be provisioned for this tenant

  const metrics: Metric[] = [
    {
      label: "Today's visits",
      value: data?.visitsToday.length ?? 0,
      icon: CalendarCheck,
      color: 'text-emerald-600',
      iconBg: 'bg-emerald-100 text-emerald-600',
      href: '/sitevisits',
    },
    {
      label: 'Hot leads',
      value: data?.hotLeads.length ?? 0,
      icon: Flame,
      color: 'text-rose-600',
      iconBg: 'bg-rose-100 text-rose-600',
      href: '/leads',
    },
    {
      label: 'Follow-ups due',
      value: data?.followupsDue.length ?? 0,
      icon: Clock,
      color: 'text-sky-600',
      iconBg: 'bg-sky-100 text-sky-600',
      href: '/leads',
    },
    {
      label: 'Drafts to approve',
      value: data?.pendingApprovals ?? 0,
      icon: CheckSquare,
      color: 'text-amber-600',
      iconBg: 'bg-amber-100 text-amber-600',
      href: '/approvals',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {metrics.map((m) => (
        <Link key={m.label} href={m.href} className="group">
          <Card className="p-5 transition group-hover:border-accent group-hover:shadow-md">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-muted-foreground">{m.label}</p>
                {isLoading ? (
                  <Skeleton className="mt-2 h-9 w-14" />
                ) : (
                  <p className={`mt-1 text-3xl font-bold tracking-tight ${m.color}`}>{m.value}</p>
                )}
              </div>
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${m.iconBg}`}>
                <m.icon className="h-5 w-5" />
              </div>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}
