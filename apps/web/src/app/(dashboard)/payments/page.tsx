'use client';

import { useState } from 'react';
import { CreditCard, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { usePayments } from '@/hooks/use-queries';
import { formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import type { PaymentStatus } from '@/lib/types';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED'].map((v) => ({
    label: humanizeEnum(v),
    value: v,
  })),
];

export default function PaymentsPage() {
  const [status, setStatus] = useState('');
  const { data, isLoading, isError, error, refetch } = usePayments({
    status: (status || undefined) as PaymentStatus | undefined,
  });

  return (
    <div>
      <PageHeader title="Payments" description="Payment links, captures and refunds." />

      <div className="space-y-4 p-4 lg:p-6">
        <div className="w-full sm:w-48">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
        </div>

        <Card>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
          ) : !data || data.data.length === 0 ? (
            <EmptyState icon={CreditCard} title="No payments found" description="Payments and links will appear here." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Payment ID</TH>
                  <TH>Amount</TH>
                  <TH>Method</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Link</TH>
                </TR>
              </THead>
              <TBody>
                {data.data.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs">{p.id.slice(0, 8)}…</TD>
                    <TD className="font-medium">{paiseToRupees(p.amount)}</TD>
                    <TD>{p.method ? <Badge tone="info">{humanizeEnum(p.method)}</Badge> : <span className="text-muted-foreground">—</span>}</TD>
                    <TD>
                      <StatusBadge value={p.status} />
                    </TD>
                    <TD className="text-muted-foreground">{formatDateTimeIST(p.createdAt)}</TD>
                    <TD>
                      {p.paymentLinkShortUrl || p.paymentLinkUrl ? (
                        <a
                          href={p.paymentLinkShortUrl ?? p.paymentLinkUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Open <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
