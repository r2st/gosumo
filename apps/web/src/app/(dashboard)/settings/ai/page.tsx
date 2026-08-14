'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { AlertTriangle, Bot, UserCheck, Zap } from 'lucide-react';
import {
  useBusinessSettings,
  useConfidenceThresholds,
  useUpdateBusinessSettings,
  useUpdateThresholds,
} from '@/hooks/use-settings';
import {
  SettingsCard,
  SaveButton,
  ReadOnlyFieldset,
  ReadOnlyNotice,
} from '@/components/settings/settings-kit';
import { usePermissions } from '@/hooks/use-permissions';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { LoadingState, ErrorState } from '@/components/ui/states';
import type { BusinessSettings } from '@/lib/feature-types';

export default function AiConfigPage() {
  return (
    <>
      <ThresholdsForm />
      <BehaviourForm />
    </>
  );
}

function ThresholdsForm() {
  const { data, isLoading, isError, refetch } = useConfidenceThresholds();
  const update = useUpdateThresholds();
  // PATCH /ai/confidence/thresholds is @Roles(MANAGER).
  const { canManage } = usePermissions();
  const [autoExecute, setAutoExecute] = useState(90);
  const [draftReview, setDraftReview] = useState(70);

  useEffect(() => {
    if (data) {
      setAutoExecute(data.autoExecute);
      setDraftReview(data.draftReview);
    }
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState onRetry={() => void refetch()} />;

  const dirty = autoExecute !== data.autoExecute || draftReview !== data.draftReview;
  const onAuto = (v: number) => {
    setAutoExecute(v);
    if (draftReview >= v) setDraftReview(v - 1);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate({ autoExecute, draftReview });
      }}
    >
      <ReadOnlyFieldset readOnly={!canManage}>
        <SettingsCard
          title="Confidence routing"
          description="How the AI decides whether to act automatically, draft for review, or escalate to a human."
          footer={
            canManage ? (
              <SaveButton
                isPending={update.isPending}
                isSuccess={update.isSuccess}
                isError={update.isError}
                dirty={dirty}
              />
            ) : (
              <ReadOnlyNotice>
                Only a manager or owner can change confidence routing.
              </ReadOnlyNotice>
            )
          }
        >
          <div className="space-y-1.5">
            <div className="flex h-7 overflow-hidden rounded-lg text-xs font-medium text-white">
              <div
                className="flex items-center justify-center bg-warning"
                style={{ width: `${draftReview}%` }}
              >
                Escalate
              </div>
              <div
                className="flex items-center justify-center bg-primary"
                style={{ width: `${autoExecute - draftReview}%` }}
              >
                Review
              </div>
              <div
                className="flex items-center justify-center bg-success"
                style={{ width: `${100 - autoExecute}%` }}
              >
                Auto
              </div>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span>confidence</span>
              <span>100%</span>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <ThresholdSlider
              label="Draft for review at"
              description="Below this, the AI escalates to a human."
              icon={UserCheck}
              min={10}
              max={autoExecute - 1}
              value={draftReview}
              onChange={setDraftReview}
            />
            <ThresholdSlider
              label="Auto-execute at"
              description="At or above this, the AI acts without review."
              icon={Zap}
              min={draftReview + 1}
              max={100}
              value={autoExecute}
              onChange={onAuto}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <BandCard
              icon={AlertTriangle}
              tone="text-warning bg-warning/10"
              title="Escalate"
              range={`< ${draftReview}%`}
              desc="Full human takeover"
            />
            <BandCard
              icon={UserCheck}
              tone="text-primary bg-accent"
              title="Review"
              range={`${draftReview}–${autoExecute - 1}%`}
              desc="Human approves draft"
            />
            <BandCard
              icon={Zap}
              tone="text-success bg-success/10"
              title="Auto"
              range={`≥ ${autoExecute}%`}
              desc="Sent automatically"
            />
          </div>
        </SettingsCard>
      </ReadOnlyFieldset>
    </form>
  );
}

function ThresholdSlider({
  label,
  description,
  icon: Icon,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" /> {label}
        </span>
        <span className="text-sm font-semibold tabular-nums text-primary">{value}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function BandCard({
  icon: Icon,
  tone,
  title,
  range,
  desc,
}: {
  icon: ComponentType<{ className?: string }>;
  tone: string;
  title: string;
  range: string;
  desc: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className={`mb-1.5 inline-flex h-7 w-7 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-sm font-medium text-foreground">
        {title} <span className="text-xs font-normal text-muted-foreground">{range}</span>
      </p>
      <p className="text-xs text-muted-foreground">{desc}</p>
    </div>
  );
}

const AUTONOMY_OPTIONS = [
  { value: 'CONSERVATIVE', label: 'Conservative — escalate more often' },
  { value: 'BALANCED', label: 'Balanced — mix of automation and oversight' },
  { value: 'AGGRESSIVE', label: 'Aggressive — maximise automation' },
];

function BehaviourForm() {
  const { data, isLoading, isError, refetch } = useBusinessSettings();
  const update = useUpdateBusinessSettings();
  // PATCH /business/settings is @Roles(MANAGER).
  const { canManage } = usePermissions();
  const [form, setForm] = useState<{
    aiAutoReplyEnabled: boolean;
    aiAutonomyLevel: BusinessSettings['aiAutonomyLevel'];
    defaultGreeting: string;
    defaultSignoff: string;
  } | null>(null);

  useEffect(() => {
    if (data) {
      setForm({
        aiAutoReplyEnabled: data.aiAutoReplyEnabled,
        aiAutonomyLevel: data.aiAutonomyLevel,
        defaultGreeting: data.defaultGreeting ?? '',
        defaultSignoff: data.defaultSignoff ?? '',
      });
    }
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError || !data || !form) return <ErrorState onRetry={() => void refetch()} />;

  const dirty =
    form.aiAutoReplyEnabled !== data.aiAutoReplyEnabled ||
    form.aiAutonomyLevel !== data.aiAutonomyLevel ||
    form.defaultGreeting !== (data.defaultGreeting ?? '') ||
    form.defaultSignoff !== (data.defaultSignoff ?? '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(form);
      }}
    >
      <ReadOnlyFieldset readOnly={!canManage}>
        <SettingsCard
          title="AI behaviour & tone"
          description="Control how autonomously the assistant replies and the voice it uses."
          footer={
            canManage ? (
              <SaveButton
                isPending={update.isPending}
                isSuccess={update.isSuccess}
                isError={update.isError}
                dirty={dirty}
              />
            ) : (
              <ReadOnlyNotice>Only a manager or owner can change AI behaviour.</ReadOnlyNotice>
            )
          }
        >
          <Switch
            checked={form.aiAutoReplyEnabled}
            onChange={(v) => setForm((f) => f && { ...f, aiAutoReplyEnabled: v })}
            label="Enable AI auto-reply"
            description="When off, the AI only drafts suggestions for your team."
          />

          <Field label="Autonomy level" hint="Overall risk appetite for acting without a human.">
            <Select
              options={AUTONOMY_OPTIONS}
              value={form.aiAutonomyLevel}
              onChange={(e) =>
                setForm(
                  (f) =>
                    f && {
                      ...f,
                      aiAutonomyLevel: e.target.value as BusinessSettings['aiAutonomyLevel'],
                    },
                )
              }
            />
          </Field>

          <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <Bot className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Greeting and sign-off are prepended/appended to AI replies to keep a consistent brand
              voice.
            </p>
          </div>

          <Field label="Default greeting">
            <Textarea
              rows={2}
              value={form.defaultGreeting}
              onChange={(e) => setForm((f) => f && { ...f, defaultGreeting: e.target.value })}
              placeholder="Hi! Thanks for reaching out to us 👋"
            />
          </Field>
          <Field label="Default sign-off">
            <Textarea
              rows={2}
              value={form.defaultSignoff}
              onChange={(e) => setForm((f) => f && { ...f, defaultSignoff: e.target.value })}
              placeholder="— Team [Business]"
            />
          </Field>
        </SettingsCard>
      </ReadOnlyFieldset>
    </form>
  );
}
