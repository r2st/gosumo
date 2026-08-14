'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, PlugZap, XCircle, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SecretInput } from '@/components/settings/masked-input';
import { ReadOnlyFieldset } from '@/components/settings/settings-kit';
import { useSaveIntegration, useTestIntegration } from '@/hooks/use-integrations';
import { usePermissions } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';
import type {
  IntegrationCredential,
  IntegrationProvider,
  IntegrationStatus,
  TestConnectionResult,
} from '@/lib/integration-types';

export interface IntegrationFieldDef {
  name: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  type?: string;
  options?: { label: string; value: string }[];
  /** Only render this field when another field equals a given value. */
  visibleWhen?: { field: string; equals: string };
  hint?: string;
}

export interface IntegrationDef {
  provider: IntegrationProvider;
  label: string;
  blurb: string;
  icon: LucideIcon;
  color: string;
  fields: IntegrationFieldDef[];
}

const STATUS_META: Record<IntegrationStatus, { tone: BadgeTone; label: string; icon: LucideIcon }> =
  {
    CONNECTED: { tone: 'success', label: 'Connected', icon: CheckCircle2 },
    DISCONNECTED: { tone: 'neutral', label: 'Not connected', icon: PlugZap },
    ERROR: { tone: 'danger', label: 'Error', icon: XCircle },
  };

export function IntegrationCard({
  def,
  credential,
}: {
  def: IntegrationDef;
  credential?: IntegrationCredential;
}) {
  const save = useSaveIntegration();
  const test = useTestIntegration();
  // PUT /integrations/credentials/:provider and its /test sibling are both
  // @Roles(MANAGER) — these fields hold third-party secrets.
  const { canManage } = usePermissions();
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  const initial = useMemo(() => buildInitial(def, credential), [def, credential]);
  const [form, setForm] = useState<Record<string, string>>(initial);

  // Re-sync when the stored config changes (e.g. after a save clears secrets).
  const signature = JSON.stringify(credential?.fields ?? {});
  useEffect(() => {
    setForm(buildInitial(def, credential));
    setTestResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const set = (name: string, value: string) => setForm((f) => ({ ...f, [name]: value }));

  const visibleFields = def.fields.filter(
    (f) => !f.visibleWhen || form[f.visibleWhen.field] === f.visibleWhen.equals,
  );

  // Dirty when a non-secret field changed or any secret field was filled.
  const dirty = visibleFields.some((f) => {
    if (f.secret) return !!form[f.name];
    return form[f.name] !== initial[f.name];
  });

  const buildPayload = () => {
    const credentials: Record<string, string> = {};
    for (const f of visibleFields) {
      const value = form[f.name];
      if (f.secret) {
        if (value) credentials[f.name] = value; // blank secret keeps stored value
      } else {
        credentials[f.name] = value;
      }
    }
    return { credentials };
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTestResult(null);
    save.mutate({ provider: def.provider, body: buildPayload() });
  };

  const onTest = () => {
    setTestResult(null);
    test.mutate(
      { provider: def.provider, body: buildPayload() },
      { onSuccess: (res) => setTestResult(res) },
    );
  };

  const status: IntegrationStatus =
    credential?.status ?? (credential?.configured ? 'CONNECTED' : 'DISCONNECTED');
  const meta = STATUS_META[status];
  const StatusIcon = meta.icon;
  const Icon = def.icon;

  return (
    <Card>
      <form onSubmit={onSubmit}>
        {/* Disables every credential field for a non-manager, so the form is
            readable but not editable — the Save and Test buttons below are
            hidden for the same reason. */}
        <ReadOnlyFieldset readOnly={!canManage}>
          <div className="flex items-start justify-between gap-3 border-b border-border p-5">
            <div className="flex gap-3">
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white',
                  def.color,
                )}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold text-foreground">{def.label}</p>
                <p className="text-xs text-muted-foreground">{def.blurb}</p>
              </div>
            </div>
            <Badge tone={meta.tone}>
              <StatusIcon className="h-3 w-3" /> {meta.label}
            </Badge>
          </div>

          <div className="space-y-4 p-5">
            {credential?.status === 'ERROR' && credential.errorMessage && (
              <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                {credential.errorMessage}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {visibleFields.map((f) => {
                const fieldState = credential?.fields?.[f.name];
                const full =
                  f.options || f.name.toLowerCase().includes('token') ? 'sm:col-span-2' : '';
                return (
                  <Field key={f.name} label={f.label} hint={f.hint} className={full}>
                    {f.options ? (
                      <Select
                        options={f.options}
                        value={form[f.name]}
                        onChange={(e) => set(f.name, e.target.value)}
                      />
                    ) : f.secret ? (
                      <SecretInput
                        value={form[f.name]}
                        onChange={(v) => set(f.name, v)}
                        configured={fieldState?.set}
                        last4={fieldState?.last4}
                        placeholder={f.placeholder}
                      />
                    ) : (
                      <Input
                        type={f.type ?? 'text'}
                        value={form[f.name]}
                        placeholder={f.placeholder}
                        onChange={(e) => set(f.name, e.target.value)}
                      />
                    )}
                  </Field>
                );
              })}
            </div>

            {testResult && (
              <p
                className={cn(
                  'text-xs font-medium',
                  testResult.success ? 'text-success' : 'text-danger',
                )}
              >
                {testResult.success ? '✓ ' : '✕ '}
                {testResult.message}
                {testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <span className="text-xs text-muted-foreground">
              {credential?.lastTestedAt
                ? `Last tested ${timeAgo(credential.lastTestedAt)}`
                : 'Not tested yet'}
            </span>
            <div className="flex items-center gap-2">
              {save.isSuccess && !dirty && (
                <span className="text-xs font-medium text-success">Saved</span>
              )}
              {canManage && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={test.isPending}
                    disabled={!credential?.configured && !dirty}
                    onClick={onTest}
                  >
                    Test connection
                  </Button>
                  <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>
                    Save
                  </Button>
                </>
              )}
            </div>
          </div>
        </ReadOnlyFieldset>
      </form>
    </Card>
  );
}

function buildInitial(
  def: IntegrationDef,
  credential?: IntegrationCredential,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of def.fields) {
    if (f.secret) {
      out[f.name] = '';
    } else {
      const stored = credential?.fields?.[f.name]?.value;
      out[f.name] = stored ?? f.options?.[0]?.value ?? '';
    }
  }
  return out;
}
