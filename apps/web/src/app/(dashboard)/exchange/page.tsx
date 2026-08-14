'use client';

import { useState } from 'react';
import { Handshake, Plus, Store } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SegmentedTabs } from '@/components/ui/tabs';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { SyndicationCard } from '@/components/exchange/syndication-card';
import { ReliabilityTable } from '@/components/exchange/reliability-table';
import { ExchangeMatchPanel } from '@/components/exchange/match-panel';
import { RESALE_STATUS_LABELS, type SyndicationState } from '@/lib/realty-types';
import { RESALE_STATUS_TONE } from '@/lib/exchange-ui';
import { Badge } from '@/components/ui/badge';
import { paiseToCompactRupees, formatDateIST } from '@/lib/format';
import {
  useSyndications,
  useReliabilityScores,
  useResaleListings,
  useCreateSyndication,
  useCreateResaleListing,
  useLeads,
} from '@/hooks/use-realty';
import { usePermissions } from '@/hooks/use-permissions';

type Tab = 'syndications' | 'matches' | 'reliability' | 'resale';

const TABS = [
  { key: 'syndications', label: 'Syndications' },
  { key: 'matches', label: 'Matches' },
  { key: 'reliability', label: 'Reliability' },
  { key: 'resale', label: 'Resale supply' },
];

const STATE_FILTERS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'OFFERED', label: 'Offered' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'VISIT', label: 'Visited' },
  { key: 'CLOSED', label: 'Closed' },
  { key: 'DISPUTED', label: 'Disputed' },
];

export default function ExchangePage() {
  // Undecorated writes — STAFF and above.
  const { canWrite } = usePermissions();

  const [tab, setTab] = useState<Tab>('syndications');
  const [newSynd, setNewSynd] = useState(false);
  const [newResale, setNewResale] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Exchange"
        description="Co-broking network — syndicate unmatched leads, match against network supply, and settle on trust."
        actions={
          !canWrite ? undefined : tab === 'syndications' ? (
            <Button onClick={() => setNewSynd(true)}>
              <Plus className="h-4 w-4" /> Syndicate a lead
            </Button>
          ) : tab === 'resale' ? (
            <Button onClick={() => setNewResale(true)}>
              <Plus className="h-4 w-4" /> New resale listing
            </Button>
          ) : undefined
        }
      />

      <div className="border-b border-border bg-card px-4 py-3 lg:px-6">
        <SegmentedTabs items={TABS} activeKey={tab} onChange={(k) => setTab(k as Tab)} />
      </div>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {tab === 'syndications' && <SyndicationsTab />}
        {tab === 'matches' && <ExchangeMatchPanel />}
        {tab === 'reliability' && <ReliabilityTab />}
        {tab === 'resale' && <ResaleTab />}
      </div>

      {newSynd && <NewSyndicationModal onClose={() => setNewSynd(false)} />}
      {newResale && <NewResaleModal onClose={() => setNewResale(false)} />}
    </div>
  );
}

// ── Syndications tab ──

function SyndicationsTab() {
  const [state, setState] = useState<string>('ALL');
  const q = useSyndications(state === 'ALL' ? {} : { state: state as SyndicationState });
  const syndications = q.data ?? [];

  return (
    <div className="space-y-4">
      <SegmentedTabs items={STATE_FILTERS} activeKey={state} onChange={setState} />
      {q.isLoading ? (
        <LoadingState label="Loading syndications…" />
      ) : q.isError ? (
        <ErrorState message="Could not load syndications." onRetry={() => q.refetch()} />
      ) : syndications.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No syndications yet"
          description="Syndicate a qualified lead you can't match to your own inventory and share the closing 50:50."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {syndications.map((s) => (
            <SyndicationCard key={s.id} syndication={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reliability tab ──

function ReliabilityTab() {
  const q = useReliabilityScores();
  const scores = q.data ?? [];
  return q.isLoading ? (
    <LoadingState label="Loading reliability scores…" />
  ) : q.isError ? (
    <ErrorState message="Could not load reliability scores." onRetry={() => q.refetch()} />
  ) : scores.length === 0 ? (
    <EmptyState
      icon={Handshake}
      title="No reliability scores yet"
      description="Scores build up as you close and rate syndicated deals with network partners."
    />
  ) : (
    <ReliabilityTable scores={scores} />
  );
}

// ── Resale tab ──

function ResaleTab() {
  const q = useResaleListings();
  const listings = q.data ?? [];
  return q.isLoading ? (
    <LoadingState label="Loading resale listings…" />
  ) : q.isError ? (
    <ErrorState message="Could not load resale listings." onRetry={() => q.refetch()} />
  ) : listings.length === 0 ? (
    <EmptyState
      icon={Store}
      title="No resale listings yet"
      description="Add secondary-market listings — Tier-1 oxygen that also becomes matchable exchange supply."
    />
  ) : (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {listings.map((l) => (
        <div key={l.id} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">
              {l.config} · {l.locality}
            </span>
            <Badge tone={RESALE_STATUS_TONE[l.status]}>{RESALE_STATUS_LABELS[l.status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {paiseToCompactRupees(l.askingPricePaise)}
          </p>
          {l.carpetSqft && (
            <p className="text-xs text-muted-foreground">{l.carpetSqft} sqft carpet</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {l.verifiedAt ? `Verified ${formatDateIST(l.verifiedAt)}` : 'Unverified'}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── New syndication modal ──

function NewSyndicationModal({ onClose }: { onClose: () => void }) {
  const create = useCreateSyndication();
  const leadsQ = useLeads({ limit: 50 });
  const leads = leadsQ.data?.data ?? [];
  const [leadId, setLeadId] = useState('');
  const [toBusinessId, setToBusinessId] = useState('');
  const [originatorPct, setOriginatorPct] = useState('50');
  const [counterpartyPct, setCounterpartyPct] = useState('50');

  const total = (Number(originatorPct) || 0) + (Number(counterpartyPct) || 0);
  const canSubmit = !!leadId && !!toBusinessId && total === 100;

  const submit = () => {
    create.mutate(
      {
        leadId,
        toBusinessId,
        splitTerms: {
          originatorPct: Number(originatorPct),
          counterpartyPct: Number(counterpartyPct),
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Syndicate a lead"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!canSubmit} onClick={submit}>
            Offer syndication
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Lead (must have buyer share consent)">
          <Select
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            options={[
              { value: '', label: 'Select a lead…' },
              ...leads.map((l) => ({
                value: l.id,
                label: `${l.name ?? l.whatsappPhone}${l.shareConsent ? '' : ' (no consent)'}`,
              })),
            ]}
          />
        </Field>
        <Field label="Counterparty business ID">
          <Input
            value={toBusinessId}
            onChange={(e) => setToBusinessId(e.target.value)}
            placeholder="UUID of the broker you're sharing with"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your share (%)">
            <Input
              type="number"
              min={0}
              max={100}
              value={originatorPct}
              onChange={(e) => setOriginatorPct(e.target.value)}
            />
          </Field>
          <Field label="Their share (%)">
            <Input
              type="number"
              min={0}
              max={100}
              value={counterpartyPct}
              onChange={(e) => setCounterpartyPct(e.target.value)}
            />
          </Field>
        </div>
        {total !== 100 && (
          <p className="text-xs text-danger">Split must sum to 100 (currently {total}).</p>
        )}
        {create.isError && (
          <p className="text-xs text-danger">
            Could not create the syndication. The buyer may not have consented to sharing.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── New resale listing modal ──

function NewResaleModal({ onClose }: { onClose: () => void }) {
  const create = useCreateResaleListing();
  const [locality, setLocality] = useState('');
  const [config, setConfig] = useState('');
  const [askingRupees, setAskingRupees] = useState('');
  const [sellerPhone, setSellerPhone] = useState('');
  const [carpet, setCarpet] = useState('');

  const canSubmit = !!locality && !!config && !!askingRupees && !!sellerPhone;

  const submit = () => {
    create.mutate(
      {
        locality,
        config,
        askingPricePaise: Math.round(Number(askingRupees) * 100),
        sellerPhone,
        carpetSqft: carpet ? Number(carpet) : undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New resale listing"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!canSubmit} onClick={submit}>
            Add listing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Locality">
          <Input
            value={locality}
            onChange={(e) => setLocality(e.target.value)}
            placeholder="Baner"
          />
        </Field>
        <Field label="Configuration">
          <Input value={config} onChange={(e) => setConfig(e.target.value)} placeholder="2BHK" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Asking price (₹)">
            <Input
              type="number"
              min={0}
              value={askingRupees}
              onChange={(e) => setAskingRupees(e.target.value)}
            />
          </Field>
          <Field label="Carpet (sqft)">
            <Input
              type="number"
              min={0}
              value={carpet}
              onChange={(e) => setCarpet(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Seller phone (private)">
          <Input
            value={sellerPhone}
            onChange={(e) => setSellerPhone(e.target.value)}
            placeholder="+9198…"
          />
        </Field>
        {create.isError && (
          <p className="text-xs text-danger">Could not add the listing. Check the details.</p>
        )}
      </div>
    </Modal>
  );
}
