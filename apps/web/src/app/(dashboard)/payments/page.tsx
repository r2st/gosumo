'use client';

import { useState } from 'react';
import { CreditCard, ExternalLink, FileText, Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { SegmentedTabs } from '@/components/ui/tabs';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { RevenueSummary } from '@/components/payments/revenue-summary';
import { CreatePaymentLinkModal } from '@/components/payments/create-payment-link-modal';
import { PaymentDetailDrawer } from '@/components/payments/payment-detail-drawer';
import { InvoiceDetailDrawer } from '@/components/payments/invoice-detail-drawer';
import { usePayments } from '@/hooks/use-payments';
import { formatDateIST, formatDateTimeIST, humanizeEnum, paiseToRupees } from '@/lib/format';
import { invoiceNumber, isInvoiceable } from '@/lib/commerce-types';
import type { Payment, PaymentMethod, PaymentStatus } from '@/lib/types';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED'].map((v) => ({
    label: humanizeEnum(v),
    value: v,
  })),
];

const METHOD_OPTIONS = [
  { label: 'All methods', value: '' },
  ...['UPI', 'CARD', 'NETBANKING', 'WALLET', 'COD', 'EMI'].map((v) => ({ label: humanizeEnum(v), value: v })),
];

export default function PaymentsPage() {
  const [tab, setTab] = useState('payments');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Payment | null>(null);

  const isInvoices = tab === 'invoices';

  const { data, isLoading, isError, error, refetch } = usePayments({
    status: !isInvoices && status ? (status as PaymentStatus) : undefined,
    method: !isInvoices && method ? (method as PaymentMethod) : undefined,
    limit: 100,
  });

  const invoices = (data?.data ?? []).filter((p) => isInvoiceable(p.status));

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Payment links, captures, refunds and invoices."
        actions={
          <Button onClick={() => setLinkOpen(true)}>
            <Plus className="h-4 w-4" /> Payment link
          </Button>
        }
      />

      <div className="space-y-4 p-4 lg:p-6">
        <RevenueSummary />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedTabs
            items={[
              { key: 'payments', label: 'Payments' },
              { key: 'invoices', label: 'Invoices' },
            ]}
            activeKey={tab}
            onChange={setTab}
          />
          {!isInvoices && (
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="w-full sm:w-44">
                <Select value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS_OPTIONS} />
              </div>
              <div className="w-full sm:w-40">
                <Select value={method} onChange={(e) => setMethod(e.target.value)} options={METHOD_OPTIONS} />
              </div>
            </div>
          )}
        </div>

        <Card>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
          ) : isInvoices ? (
            invoices.length === 0 ? (
              <EmptyState icon={FileText} title="No invoices yet" description="Captured payments generate invoices automatically." />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Invoice</TH>
                    <TH>Client</TH>
                    <TH>Amount</TH>
                    <TH>Status</TH>
                    <TH>Date</TH>
                  </TR>
                </THead>
                <TBody>
                  {invoices.map((p) => (
                    <TR key={p.id} className="cursor-pointer" onClick={() => setInvoice(p)}>
                      <TD className="font-mono text-xs font-medium">{invoiceNumber(p)}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <Avatar name={p.client?.name ?? 'Client'} src={p.client?.avatarUrl} size="sm" />
                          <span className="truncate">{p.client?.name ?? '—'}</span>
                        </div>
                      </TD>
                      <TD className="font-medium">{paiseToRupees(p.amount)}</TD>
                      <TD>
                        <StatusBadge value={p.status} />
                      </TD>
                      <TD className="text-muted-foreground">{formatDateIST(p.capturedAt ?? p.createdAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )
          ) : !data || data.data.length === 0 ? (
            <EmptyState icon={CreditCard} title="No payments found" description="Payments and links will appear here." />
          ) : (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Payment ID</TH>
                  <TH>Client</TH>
                  <TH>Amount</TH>
                  <TH>Method</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Link</TH>
                </TR>
              </THead>
              <TBody>
                {data.data.map((p) => (
                  <TR key={p.id} className="cursor-pointer" onClick={() => setDetailId(p.id)}>
                    <TD className="font-mono text-xs">{p.id.slice(0, 8)}…</TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <Avatar name={p.client?.name ?? 'Client'} src={p.client?.avatarUrl} size="sm" />
                        <span className="truncate">{p.client?.name ?? '—'}</span>
                      </div>
                    </TD>
                    <TD className="font-medium">{paiseToRupees(p.amount)}</TD>
                    <TD>{p.method ? <Badge tone="info">{humanizeEnum(p.method)}</Badge> : <span className="text-muted-foreground">—</span>}</TD>
                    <TD>
                      <StatusBadge value={p.status} />
                    </TD>
                    <TD className="text-muted-foreground">{formatDateTimeIST(p.createdAt)}</TD>
                    <TD onClick={(e) => e.stopPropagation()}>
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

      <CreatePaymentLinkModal open={linkOpen} onClose={() => setLinkOpen(false)} />
      <PaymentDetailDrawer paymentId={detailId} onClose={() => setDetailId(null)} />
      <InvoiceDetailDrawer payment={invoice} onClose={() => setInvoice(null)} />
    </div>
  );
}
