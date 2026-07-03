'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { FileText, MessageSquare, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { SettingsCard, SaveButton, FormRow } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { useToast } from '@/providers/toast-provider';
import { useLanguage } from '@/providers/language-provider';
import {
  useComplianceSettings,
  useCorrection,
  useDataRequest,
  useErasure,
  useRunRetention,
  useUpdateComplianceSettings,
} from '@/hooks/use-compliance';
import { useIntelligenceOptIn, useSetIntelligenceOptIn } from '@/hooks/use-realty';
import { formatDateTimeIST } from '@/lib/format';
import type { ComplianceSettings, DataAccessResult } from '@/lib/compliance-types';

export default function PrivacyPage() {
  return (
    <>
      <ComplianceNotice />
      <DataSubjectRights />
      <RetentionSettings />
      <NetworkConsent />
    </>
  );
}

// ── DPDPA compliance notice ──────────────────────────────────────────────────────

function ComplianceNotice() {
  const { t } = useLanguage();
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-accent/50 p-4">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      <div>
        <p className="text-sm font-semibold text-foreground">{t('privacy.noticeTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('privacy.noticeBody')}</p>
      </div>
    </div>
  );
}

// ── Data-principal rights (access / correction / erasure) ────────────────────────

function DataSubjectRights() {
  const { t } = useLanguage();
  const [phone, setPhone] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const query = useDataRequest(submitted);

  const onLookup = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = phone.trim();
    if (trimmed) setSubmitted(trimmed);
  };

  return (
    <SettingsCard title={t('privacy.rightsTitle')} description={t('privacy.rightsDesc')}>
      <form onSubmit={onLookup} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={t('privacy.buyerPhone')} className="flex-1">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91…"
            inputMode="tel"
          />
        </Field>
        <Button type="submit" disabled={!phone.trim()}>
          <Search className="h-4 w-4" /> {t('privacy.lookup')}
        </Button>
      </form>

      {submitted && (
        <div className="mt-2">
          {query.isLoading ? (
            <LoadingState label={t('common.loading')} />
          ) : query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : query.data && !query.data.found ? (
            <EmptyState icon={Search} title={t('privacy.noDataForPhone')} />
          ) : query.data ? (
            <DataResult data={query.data} phone={submitted} />
          ) : null}
        </div>
      )}
    </SettingsCard>
  );
}

function DataResult({ data, phone }: { data: DataAccessResult; phone: string }) {
  const { t } = useLanguage();
  const lead = data.lead!;

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      {/* Right of access — collected data */}
      <div>
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileText className="h-4 w-4 text-primary" /> {t('privacy.collectedData')}
        </p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <Row label={t('privacy.name')} value={lead.name} />
          <Row label={t('privacy.email')} value={lead.email} />
          <Row label={t('privacy.buyerPhone')} value={lead.whatsappPhone} />
          <Row label={t('privacy.stage')} value={lead.stage} />
          <Row label={t('privacy.source')} value={lead.source} />
        </dl>
      </div>

      {/* Messages */}
      {data.messages.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessageSquare className="h-4 w-4 text-primary" /> {t('privacy.messages')} · {data.messages.length}
          </p>
        </div>
      )}

      {/* Consent history */}
      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">{t('privacy.consent')}</p>
        {data.consents.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="space-y-1.5">
            {data.consents.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium text-foreground">{c.consent_type}</span>
                <Badge tone={c.revoked_at ? 'neutral' : 'success'}>
                  {c.revoked_at ? t('privacy.revoked') : t('privacy.granted')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CorrectionForm phone={phone} lead={lead} />
      <ErasureControl phone={phone} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/50 py-1 sm:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value || '—'}</dd>
    </div>
  );
}

function CorrectionForm({ phone, lead }: { phone: string; lead: NonNullable<DataAccessResult['lead']> }) {
  const { t } = useLanguage();
  const toast = useToast();
  const correction = useCorrection();
  const [name, setName] = useState(lead.name ?? '');
  const [email, setEmail] = useState(lead.email ?? '');

  const dirty = name !== (lead.name ?? '') || email !== (lead.email ?? '');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    correction.mutate(
      { phone, name, email },
      {
        onSuccess: () => toast.success(t('privacy.corrected')),
        onError: () => toast.error('Could not save the correction.'),
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 border-t border-border pt-4">
      <p className="text-sm font-semibold text-foreground">{t('privacy.requestCorrection')}</p>
      <FormRow>
        <Field label={t('privacy.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('privacy.email')}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </FormRow>
      <div className="flex justify-end">
        <SaveButton
          isPending={correction.isPending}
          isSuccess={correction.isSuccess}
          isError={correction.isError}
          dirty={dirty}
        >
          {t('common.save')}
        </SaveButton>
      </div>
    </form>
  );
}

function ErasureControl({ phone }: { phone: string }) {
  const { t } = useLanguage();
  const toast = useToast();
  const erasure = useErasure();

  const onErase = () => {
    if (!window.confirm(t('privacy.erasureConfirm'))) return;
    erasure.mutate(phone, {
      onSuccess: () => toast.success(t('privacy.erased')),
      onError: () => toast.error('Could not erase this buyer’s data.'),
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{t('privacy.requestErasure')}</p>
        <p className="text-xs text-muted-foreground">{t('privacy.erasure')}</p>
      </div>
      <Button variant="danger" size="sm" loading={erasure.isPending} onClick={onErase}>
        <Trash2 className="h-4 w-4" /> {t('privacy.requestErasure')}
      </Button>
    </div>
  );
}

// ── Retention policy ─────────────────────────────────────────────────────────────

function RetentionSettings() {
  const { t } = useLanguage();
  const { data, isLoading, isError, refetch } = useComplianceSettings();

  if (isLoading) return <LoadingState label={t('common.loading')} />;
  if (isError || !data) return <ErrorState onRetry={() => void refetch()} />;
  return <RetentionForm settings={data} />;
}

function RetentionForm({ settings }: { settings: ComplianceSettings }) {
  const { t } = useLanguage();
  const toast = useToast();
  const update = useUpdateComplianceSettings();
  const runRetention = useRunRetention();

  const [months, setMonths] = useState(String(settings.retentionMonths));
  const [agreed, setAgreed] = useState(settings.dataProcessorAgreement);

  useEffect(() => {
    setMonths(String(settings.retentionMonths));
    setAgreed(settings.dataProcessorAgreement);
  }, [settings]);

  const parsedMonths = Number(months);
  const validMonths = Number.isFinite(parsedMonths) && parsedMonths >= 1 && parsedMonths <= 120;
  const dirty =
    (validMonths && parsedMonths !== settings.retentionMonths) ||
    agreed !== settings.dataProcessorAgreement;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!validMonths) return;
    update.mutate(
      { retentionMonths: parsedMonths, dataProcessorAgreement: agreed },
      {
        onSuccess: () => toast.success('Retention policy saved.'),
        onError: () => toast.error('Could not save your changes.'),
      },
    );
  };

  const onRun = () => {
    runRetention.mutate(undefined, {
      onSuccess: (res) => toast.success(`Retention sweep complete — ${res.leadsAnonymized} erased.`),
      onError: () => toast.error('Could not run the retention sweep.'),
    });
  };

  return (
    <form onSubmit={onSubmit}>
      <SettingsCard
        title={t('privacy.retentionTitle')}
        description={t('privacy.retentionDesc')}
        footer={
          <SaveButton
            isPending={update.isPending}
            isSuccess={update.isSuccess}
            isError={update.isError}
            dirty={dirty}
          >
            {t('common.saveChanges')}
          </SaveButton>
        }
      >
        <FormRow>
          <Field label={t('privacy.retentionMonths')} hint="1–120">
            <Input
              type="number"
              min={1}
              max={120}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </Field>
          <div className="flex flex-col justify-end">
            <p className="text-xs text-muted-foreground">{t('privacy.lastRun')}</p>
            <p className="text-sm font-medium text-foreground">
              {settings.lastRetentionRunAt ? formatDateTimeIST(settings.lastRetentionRunAt) : t('privacy.never')}
            </p>
          </div>
        </FormRow>

        <Switch
          checked={agreed}
          onChange={setAgreed}
          label={t('privacy.processorAgreement')}
          description={t('privacy.processorAgreementDesc')}
        />

        <div className="flex justify-start">
          <Button type="button" variant="outline" size="sm" loading={runRetention.isPending} onClick={onRun}>
            {t('privacy.runRetention')}
          </Button>
        </div>
      </SettingsCard>
    </form>
  );
}

// ── Network intelligence consent (view / revoke) ─────────────────────────────────

function NetworkConsent() {
  const { t } = useLanguage();
  const { data, isLoading } = useIntelligenceOptIn();
  const setOptIn = useSetIntelligenceOptIn();
  const optIn = data?.optIn ?? false;

  return (
    <SettingsCard title={t('privacy.consentTitle')} description={t('privacy.consentDesc')}>
      <Switch
        checked={optIn}
        disabled={isLoading || setOptIn.isPending}
        onChange={(next) => setOptIn.mutate(next)}
        label={optIn ? t('privacy.granted') : t('privacy.revoked')}
        description={t('intel.optInDesc')}
      />
    </SettingsCard>
  );
}
