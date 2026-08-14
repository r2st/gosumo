'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Search, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { useClients } from '@/hooks/use-queries';
import { formatDateIST, paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ClientFilters } from '@/lib/api-client';

interface Segment {
  key: string;
  label: string;
  filters: ClientFilters;
}

const SEGMENTS: Segment[] = [
  { key: 'all', label: 'All clients', filters: {} },
  { key: 'at-risk', label: 'At-risk', filters: { churnRiskLevel: 'HIGH' } },
  { key: 'new', label: 'New', filters: { hasOrders: false } },
  { key: 'returning', label: 'Returning', filters: { hasOrders: true } },
];

export default function ClientsPage() {
  const [segment, setSegment] = useState('all');
  const [q, setQ] = useState('');

  const active = SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0];
  const { data, isLoading, isError, error, refetch } = useClients({
    ...active.filters,
    q: q || undefined,
    limit: 50,
  });

  return (
    <div>
      <PageHeader title="Clients" description="Profiles, sentiment, churn risk and lifetime value." />

      <div className="space-y-4 p-4 lg:p-6">
        {/* Segment chips + search */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {SEGMENTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSegment(s.key)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  segment === s.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email…" className="pl-8" />
          </div>
        </div>

        <Card>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState error={error} onRetry={() => refetch()} />
          ) : !data || data.data.length === 0 ? (
            <EmptyState icon={Users} title="No clients found" description="Try a different segment or search." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Client</TH>
                  <TH>Orders</TH>
                  <TH>Total spent</TH>
                  <TH>Last active</TH>
                </TR>
              </THead>
              <TBody>
                {data.data.map((c) => (
                  <TR key={c.id} className="cursor-pointer">
                    <TD>
                      <Link href={`/clients/${c.id}`} className="flex items-center gap-3">
                        <Avatar name={c.name ?? 'Unknown'} src={c.avatarUrl ?? undefined} size="md" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{c.name ?? 'Unknown'}</p>
                          <p className="truncate text-xs text-muted-foreground">{c.phone ?? c.email ?? '—'}</p>
                        </div>
                      </Link>
                    </TD>
                    <TD>{c.totalOrders ?? 0}</TD>
                    <TD className="font-medium">{paiseToRupees(c.totalSpentPaise)}</TD>
                    <TD className="text-muted-foreground">{formatDateIST(c.lastInteractionAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        {data && (
          <p className="text-xs text-muted-foreground">
            Showing {data.data.length} of {data.pagination.total} clients
            {active.key !== 'all' && (
              <> in <span className="font-medium">{active.label}</span></>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
