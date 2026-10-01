'use client';

import { Trophy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Avatar } from '@/components/ui/avatar';
import { useConversationReportFull } from '@/hooks/use-analytics';
import type { DateRange } from '@/components/analytics/date-range-picker';
import { cn } from '@/lib/utils';
import { formatDuration, formatNumber } from '@/lib/format';

export function TeamSection({ range }: { range: DateRange }) {
  const { data, isLoading, isError, error, refetch } = useConversationReportFull(range);

  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;

  const agents = [...(data?.agentPerformance ?? [])].sort((a, b) => b.resolved - a.resolved);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent leaderboard</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {agents.length === 0 ? (
          <EmptyState icon={Trophy} title="No agent activity in this period" className="py-12" />
        ) : (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>#</TH>
                <TH>Agent</TH>
                <TH className="text-right">Resolved</TH>
                <TH className="text-right">Avg resolution</TH>
                <TH className="text-right">Approved</TH>
                <TH className="text-right">Rejected</TH>
                <TH className="text-right">Approval</TH>
              </TR>
            </THead>
            <TBody>
              {agents.map((a, idx) => {
                const total = a.tasksApproved + a.tasksRejected;
                const approval = total > 0 ? (a.tasksApproved / total) * 100 : 0;
                return (
                  <TR key={a.userId}>
                    <TD>
                      {idx < 3 ? (
                        <span
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white',
                            idx === 0 ? 'bg-primary' : idx === 1 ? 'bg-zinc-400' : 'bg-amber-700',
                          )}
                        >
                          {idx + 1}
                        </span>
                      ) : (
                        <span className="px-2 text-muted-foreground">{idx + 1}</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={a.name} size="sm" />
                        <span className="font-medium">{a.name}</span>
                      </div>
                    </TD>
                    <TD className="text-right font-semibold">{formatNumber(a.resolved)}</TD>
                    <TD className="text-right text-muted-foreground">{formatDuration(a.avgResolutionTimeMs)}</TD>
                    <TD className="text-right text-muted-foreground">{formatNumber(a.tasksApproved)}</TD>
                    <TD className="text-right text-muted-foreground">{formatNumber(a.tasksRejected)}</TD>
                    <TD className="text-right">
                      <Badge tone={approval >= 80 ? 'success' : approval >= 50 ? 'warning' : 'danger'}>
                        {approval.toFixed(0)}%
                      </Badge>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
