'use client';

import Link from 'next/link';
import { Sun, Flame, CalendarCheck, Clock, CheckSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/ui/states';
import { useMorningBriefing } from '@/hooks/use-realty';
import type { BriefingItem } from '@/lib/realty-types';

/**
 * The 7:30 AM broker digest, surfaced on the dashboard (blueprint §16):
 * today's hot leads, booked visits, and follow-ups due — one glance to start
 * the day. Backed by GET /realty/broker/briefing.
 */
export function MorningBriefing() {
  const { data, isLoading, isError } = useMorningBriefing();

  if (isError) return null; // realty may not be provisioned for this tenant

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Sun className="h-5 w-5 text-amber-500" />
          Morning briefing
        </CardTitle>
        {data && <span className="text-xs text-muted-foreground">{data.date}</span>}
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <LoadingState label="Building your briefing…" />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <BriefingColumn
              icon={<Flame className="h-4 w-4 text-rose-500" />}
              title="Hot leads"
              count={data.hotLeads.length}
              items={data.hotLeads}
            />
            <BriefingColumn
              icon={<CalendarCheck className="h-4 w-4 text-emerald-500" />}
              title="Visits today"
              count={data.visitsToday.length}
              items={data.visitsToday}
            />
            <BriefingColumn
              icon={<Clock className="h-4 w-4 text-sky-500" />}
              title="Follow-ups due"
              count={data.followupsDue.length}
              items={data.followupsDue}
            />
          </div>
        )}
        {data && (
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CheckSquare className="h-4 w-4" />
              {data.pendingApprovals} draft{data.pendingApprovals === 1 ? '' : 's'} to review
            </span>
            <Link href="/approvals" className="font-medium text-primary hover:underline">
              Open approval queue →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BriefingColumn({
  icon,
  title,
  count,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  items: BriefingItem[];
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {title}
        </span>
        <Badge tone="neutral">{count}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="py-3 text-center text-xs text-muted-foreground">Nothing yet</p>
      ) : (
        <ul className="space-y-1.5">
          {items.slice(0, 5).map((item) => (
            <li key={item.leadId}>
              <Link
                href={`/leads?lead=${item.leadId}`}
                className="block truncate text-sm hover:text-primary"
                title={item.detail}
              >
                <span className="font-medium">{item.name ?? 'Unknown buyer'}</span>
                <span className="text-muted-foreground"> · {item.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
