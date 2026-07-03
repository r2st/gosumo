'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, Handshake, IndianRupee, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { SyndicationTimeline } from '@/components/exchange/state-timeline';
import { paiseToRupees, formatDateTimeIST } from '@/lib/format';
import { SYNDICATION_STATE_LABELS, type Syndication } from '@/lib/realty-types';
import { SYNDICATION_STATE_TONE, SETTLEMENT_TONE, shortBusinessId } from '@/lib/exchange-ui';
import {
  useSyndication,
  useAcceptSyndication,
  useRecordVisit,
  useCloseSyndication,
  useExpireSyndication,
  useDisputeSyndication,
  useRateSyndication,
} from '@/hooks/use-realty';

export default function SyndicationDetailPage() {
  const params = useParams<{ syndicationId: string }>();
  const id = params?.syndicationId ?? null;
  const { data: s, isLoading, isError, refetch } = useSyndication(id);

  return (
    <div className="flex h-full flex-col">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 border-b border-border bg-card px-4 py-3 text-sm lg:px-6"
      >
        <Link href="/exchange" className="text-muted-foreground hover:text-foreground">
          Exchange
        </Link>
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium text-foreground">
          {s ? `Syndication ${shortBusinessId(s.id)}` : isLoading ? 'Loading…' : 'Syndication'}
        </span>
      </nav>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {isLoading ? (
          <LoadingState label="Loading syndication…" />
        ) : isError ? (
          <ErrorState message="Could not load this syndication." onRetry={() => refetch()} />
        ) : !s ? (
          <EmptyState icon={Handshake} title="Syndication not found" />
        ) : (
          <SyndicationDetail syndication={s} />
        )}
      </div>
    </div>
  );
}

function SyndicationDetail({ syndication: s }: { syndication: Syndication }) {
  const [disputing, setDisputing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [rating, setRating] = useState(false);

  const accept = useAcceptSyndication();
  const visit = useRecordVisit();
  const expire = useExpireSyndication();

  const isTerminal = s.state === 'CLOSED' || s.state === 'EXPIRED' || s.state === 'DISPUTED';
  const split = s.splitTerms;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={SYNDICATION_STATE_TONE[s.state]}>{SYNDICATION_STATE_LABELS[s.state]}</Badge>
          <Badge tone={SETTLEMENT_TONE[s.settlementState]}>settlement: {s.settlementState.toLowerCase()}</Badge>
        </div>
        <Link href={`/leads/${s.leadId}`} className="text-sm text-primary hover:underline">
          View lead →
        </Link>
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Deal progress</CardTitle>
        </CardHeader>
        <CardContent>
          <SyndicationTimeline state={s.state} />
        </CardContent>
      </Card>

      {/* Attribution + money */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Attribution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Originator" value={shortBusinessId(s.fromBusinessId)} mono />
            <Row label="Counterparty" value={shortBusinessId(s.toBusinessId)} mono />
            {s.developerId && <Row label="Developer" value={shortBusinessId(s.developerId)} mono />}
            <Row
              label="Split"
              value={`${split.originatorPct} / ${split.counterpartyPct}${split.developerPct ? ` / ${split.developerPct}` : ''}`}
            />
            <Row
              label="Buyer consent"
              value={s.buyerConsentAt ? formatDateTimeIST(s.buyerConsentAt) : 'Not recorded'}
            />
            <Row label="Offered" value={formatDateTimeIST(s.createdAt)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Settlement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-1 text-lg font-semibold text-foreground">
              <IndianRupee className="h-4 w-4" aria-hidden />
              {paiseToRupees(s.commissionPoolPaise).replace('₹', '')}
            </div>
            <p className="text-xs text-muted-foreground">Commission pool</p>
            <Row label="Platform fee" value={paiseToRupees(s.platformFeePaise)} />
            <Row label="State" value={s.settlementState.toLowerCase()} />
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      {!isTerminal && (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {s.state === 'OFFERED' && (
              <Button loading={accept.isPending} onClick={() => accept.mutate(s.id)}>
                Accept
              </Button>
            )}
            {s.state === 'ACCEPTED' && (
              <Button loading={visit.isPending} onClick={() => visit.mutate(s.id)}>
                Record visit
              </Button>
            )}
            {(s.state === 'ACCEPTED' || s.state === 'VISIT') && (
              <Button onClick={() => setClosing(true)}>Close deal</Button>
            )}
            <Button variant="ghost" loading={expire.isPending} onClick={() => expire.mutate(s.id)}>
              Expire
            </Button>
            <Button variant="ghost" onClick={() => setDisputing(true)}>
              Dispute
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Post-deal rating */}
      {s.state === 'CLOSED' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> Rate the counterparty
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Your rating feeds the counterparty's reliability score — the trust signal that ranks the network.
            </p>
            <Button variant="secondary" onClick={() => setRating(true)}>
              Rate this deal
            </Button>
          </CardContent>
        </Card>
      )}

      {closing && <CloseModal syndication={s} onClose={() => setClosing(false)} />}
      {disputing && <DisputeModal syndication={s} onClose={() => setDisputing(false)} />}
      {rating && <RateModal syndication={s} onClose={() => setRating(false)} />}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs text-foreground' : 'text-foreground'}>{value}</span>
    </div>
  );
}

function CloseModal({ syndication, onClose }: { syndication: Syndication; onClose: () => void }) {
  const close = useCloseSyndication();
  const [rupees, setRupees] = useState('');
  const canSubmit = Number(rupees) > 0;
  const submit = () =>
    close.mutate(
      { id: syndication.id, commissionPoolPaise: Math.round(Number(rupees) * 100) },
      { onSuccess: onClose },
    );

  return (
    <Modal
      open
      onClose={onClose}
      title="Close syndicated deal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={close.isPending} disabled={!canSubmit} onClick={submit}>
            Close deal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Commission pool (₹)">
          <Input type="number" min={0} value={rupees} onChange={(e) => setRupees(e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">
          A platform fee of 5–8% (default 6%) is taken from the pool and settlement moves to pending.
        </p>
        {close.isError && <p className="text-xs text-danger">Could not close the deal.</p>}
      </div>
    </Modal>
  );
}

function DisputeModal({ syndication, onClose }: { syndication: Syndication; onClose: () => void }) {
  const dispute = useDisputeSyndication();
  const [reason, setReason] = useState('');
  const submit = () => dispute.mutate({ id: syndication.id, reason }, { onSuccess: onClose });

  return (
    <Modal
      open
      onClose={onClose}
      title="Dispute syndication"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={dispute.isPending} disabled={!reason.trim()} onClick={submit}>
            Raise dispute
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="What went wrong?">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {dispute.isError && <p className="text-xs text-danger">Could not raise the dispute.</p>}
      </div>
    </Modal>
  );
}

function RateModal({ syndication, onClose }: { syndication: Syndication; onClose: () => void }) {
  const rate = useRateSyndication();
  const [showedUp, setShowedUp] = useState(true);
  const [splitHonored, setSplitHonored] = useState(true);
  const [documented, setDocumented] = useState(true);
  const [responseMinutes, setResponseMinutes] = useState('');

  const submit = () =>
    rate.mutate(
      {
        id: syndication.id,
        ratings: {
          showedUp,
          splitHonored,
          documented,
          responseMinutes: responseMinutes ? Number(responseMinutes) : undefined,
        },
      },
      { onSuccess: onClose },
    );

  return (
    <Modal
      open
      onClose={onClose}
      title="Rate the counterparty"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={rate.isPending} onClick={submit}>
            Submit rating
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Check label="Showed up for the visit" checked={showedUp} onChange={setShowedUp} />
        <Check label="Honoured the agreed split" checked={splitHonored} onChange={setSplitHonored} />
        <Check label="Deal was fully documented" checked={documented} onChange={setDocumented} />
        <Field label="First response time (minutes, optional)">
          <Input type="number" min={0} value={responseMinutes} onChange={(e) => setResponseMinutes(e.target.value)} />
        </Field>
        {rate.isError && <p className="text-xs text-danger">Could not submit the rating.</p>}
      </div>
    </Modal>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      {label}
    </label>
  );
}
