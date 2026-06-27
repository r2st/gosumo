'use client';

import { useState } from 'react';
import {
  Globe,
  MessageCircle,
  Mail,
  Smartphone,
  Instagram,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
} from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/states';
import { useOnboardingChat } from '@/hooks/use-onboarding';
import type { OnboardingStepId } from '@/lib/onboarding-types';

/** Each step receives its saved data and reports patches back to the wizard. */
export interface StepProps {
  value: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo', 'UTC'];

// ── 1. Welcome & Business Profile ───────────────────────────────────────────
function WelcomeStep({ value, onChange }: StepProps) {
  return (
    <div className="space-y-4">
      <Field label="Business name">
        <Input
          value={str(value.businessName)}
          onChange={(e) => onChange({ businessName: e.target.value })}
          placeholder="Acme Salon & Spa"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Industry">
          <Input
            value={str(value.industry)}
            onChange={(e) => onChange({ industry: e.target.value })}
            placeholder="Salon, Retail, Clinic…"
          />
        </Field>
        <Field label="Timezone" hint="Used for business hours and scheduling.">
          <Select
            options={TIMEZONES.map((tz) => ({ label: tz, value: tz }))}
            value={str(value.timezone, 'Asia/Kolkata')}
            onChange={(e) => onChange({ timezone: e.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Opening time" hint="When the AI replies live.">
          <Input
            type="time"
            value={str(value.openTime, '09:00')}
            onChange={(e) => onChange({ openTime: e.target.value })}
          />
        </Field>
        <Field label="Closing time">
          <Input
            type="time"
            value={str(value.closeTime, '18:00')}
            onChange={(e) => onChange({ closeTime: e.target.value })}
          />
        </Field>
      </div>
      <Field label="What does your business do?" hint="Helps the AI represent you accurately.">
        <Textarea
          rows={3}
          value={str(value.description)}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="We run a neighbourhood salon offering haircuts, colouring and spa packages…"
        />
      </Field>
    </div>
  );
}

// ── 2. Connect Channels ─────────────────────────────────────────────────────
const CHANNELS = [
  { id: 'WEB_CHAT', label: 'WebChat', icon: Globe, hint: 'Works instantly — embed a widget on your site.' },
  { id: 'WHATSAPP', label: 'WhatsApp', icon: MessageCircle, hint: 'Needs a WhatsApp Business account via Meta.' },
  { id: 'EMAIL', label: 'Email', icon: Mail, hint: 'Connect via SMTP/IMAP or a forwarding address.' },
  { id: 'SMS', label: 'SMS', icon: Smartphone, hint: 'Indian DLT-registered sender ID required.' },
  { id: 'INSTAGRAM', label: 'Instagram', icon: Instagram, hint: 'Professional account linked to a Facebook Page.' },
] as const;

function ChannelsStep({ value, onChange }: StepProps) {
  const selected = Array.isArray(value.selected) ? (value.selected as string[]) : [];
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id];
    onChange({ selected: next });
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pick the channels you want to connect. WebChat works immediately; others guide you through provider setup.
      </p>
      <div className="space-y-2">
        {CHANNELS.map((c) => {
          const on = selected.includes(c.id);
          const Icon = c.icon;
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => toggle(c.id)}
              className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
              }`}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {c.label}
                  {on && <Badge tone="success">Selected</Badge>}
                </span>
                <span className="block text-xs text-muted-foreground">{c.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {selected.includes('WHATSAPP') && (
        <Field label="WhatsApp number (E.164)" hint="e.g. +919876543210 — must not be on the consumer WhatsApp app.">
          <Input
            value={str(value.whatsappNumber)}
            onChange={(e) => onChange({ whatsappNumber: e.target.value })}
            placeholder="+91…"
          />
        </Field>
      )}
    </div>
  );
}

// ── 3. Add Catalog ──────────────────────────────────────────────────────────
interface CatalogItem {
  name: string;
  type: string;
  price: string;
}

function CatalogStep({ value, onChange }: StepProps) {
  const items = Array.isArray(value.items) ? (value.items as CatalogItem[]) : [];
  const [draft, setDraft] = useState<CatalogItem>({ name: '', type: 'SERVICE', price: '' });

  const add = () => {
    if (!draft.name.trim()) return;
    onChange({ items: [...items, draft] });
    setDraft({ name: '', type: 'SERVICE', price: '' });
  };
  const remove = (i: number) => onChange({ items: items.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add a few products or services so the AI can quote prices accurately. You can bulk-import later from Catalog → Import.
      </p>

      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1 font-medium">{it.name}</span>
              <Badge tone="neutral">{it.type}</Badge>
              <span className="w-20 text-right text-muted-foreground">{it.price ? `₹${it.price}` : '—'}</span>
              <button type="button" onClick={() => remove(i)} aria-label="Remove" className="text-muted-foreground hover:text-danger">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
        <Field label="Item name">
          <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Haircut" />
        </Field>
        <Field label="Type">
          <Select
            className="w-28"
            options={[
              { label: 'Service', value: 'SERVICE' },
              { label: 'Product', value: 'PRODUCT' },
            ]}
            value={draft.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
          />
        </Field>
        <Field label="Price (₹)">
          <Input
            className="w-24"
            inputMode="numeric"
            value={draft.price}
            onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
            placeholder="499"
          />
        </Field>
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
    </div>
  );
}

// ── 4. Configure AI ─────────────────────────────────────────────────────────
function AiConfigStep({ value, onChange }: StepProps) {
  const autoReply = value.autoReply !== false; // default on
  return (
    <div className="space-y-4">
      <Switch
        checked={autoReply}
        onChange={(v) => onChange({ autoReply: v })}
        label="Enable AI auto-reply"
        description="When confident, the AI answers customers automatically."
      />
      <Field label="AI tone & personality" hint="A short instruction applied to every reply.">
        <Textarea
          rows={2}
          value={str(value.tone)}
          onChange={(e) => onChange({ tone: e.target.value })}
          placeholder="Friendly and concise; use simple Hindi-English; always greet by name."
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Auto-reply above (%)" hint="At/above this confidence the AI replies on its own.">
          <Input
            type="number"
            min={50}
            max={100}
            value={num(value.autoExecuteThreshold, 90)}
            onChange={(e) => onChange({ autoExecuteThreshold: Number(e.target.value) })}
          />
        </Field>
        <Field label="Draft for review above (%)" hint="Between this and the auto threshold, a human approves.">
          <Input
            type="number"
            min={0}
            max={100}
            value={num(value.reviewThreshold, 70)}
            onChange={(e) => onChange({ reviewThreshold: Number(e.target.value) })}
          />
        </Field>
      </div>
      <Field label="Default response language">
        <Select
          options={[
            { label: 'English', value: 'en' },
            { label: 'Hindi', value: 'hi' },
            { label: 'Hinglish', value: 'hi-en' },
          ]}
          value={str(value.language, 'en')}
          onChange={(e) => onChange({ language: e.target.value })}
        />
      </Field>
    </div>
  );
}

// ── 5. Invite Team ──────────────────────────────────────────────────────────
interface Member {
  email: string;
  role: string;
}

function TeamStep({ value, onChange }: StepProps) {
  const members = Array.isArray(value.members) ? (value.members as Member[]) : [];
  const [draft, setDraft] = useState<Member>({ email: '', role: 'AGENT' });

  const add = () => {
    if (!draft.email.trim()) return;
    onChange({ members: [...members, draft] });
    setDraft({ email: '', role: 'AGENT' });
  };
  const remove = (i: number) => onChange({ members: members.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Invite teammates to handle escalations. Roles: Admin, Agent (handles chats), Viewer (read-only).
      </p>

      {members.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((m, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1 truncate">{m.email}</span>
              <Badge tone="primary">{m.role}</Badge>
              <button type="button" onClick={() => remove(i)} aria-label="Remove" className="text-muted-foreground hover:text-danger">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <Field label="Email">
          <Input
            type="email"
            value={draft.email}
            onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            placeholder="teammate@business.in"
          />
        </Field>
        <Field label="Role">
          <Select
            className="w-32"
            options={[
              { label: 'Admin', value: 'ADMIN' },
              { label: 'Agent', value: 'AGENT' },
              { label: 'Viewer', value: 'VIEWER' },
            ]}
            value={draft.role}
            onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
          />
        </Field>
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-4 w-4" /> Invite
        </Button>
      </div>
    </div>
  );
}

// ── 6. Quick Test ───────────────────────────────────────────────────────────
function TestStep({ value, onChange }: StepProps) {
  const [message, setMessage] = useState(str(value.testMessage, 'Hi, what are your opening hours?'));
  const [reply, setReply] = useState<string | null>(str(value.testReply) || null);
  const chat = useOnboardingChat();

  const run = () => {
    if (!message.trim() || chat.isPending) return;
    chat.mutate(
      { message, step: 'TEST' },
      {
        onSuccess: (res) => {
          setReply(res.reply);
          onChange({ testMessage: message, testReply: res.reply, ran: true });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Send a sample customer message to see how the AI responds. WebChat is the quickest channel to test.
      </p>
      <Field label="Test message">
        <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Button type="button" onClick={run} loading={chat.isPending}>
        <Send className="h-4 w-4" /> Send test message
      </Button>

      {chat.isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Getting the AI response…
        </div>
      )}

      {reply && !chat.isPending && (
        <div className="rounded-lg border border-success/40 bg-success/5 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4" /> AI responded
          </p>
          <p className="whitespace-pre-wrap text-sm text-foreground">{reply}</p>
        </div>
      )}
    </div>
  );
}

/** Maps each step id to its form component. */
export const STEP_COMPONENTS: Record<OnboardingStepId, (props: StepProps) => JSX.Element> = {
  WELCOME: WelcomeStep,
  CHANNELS: ChannelsStep,
  CATALOG: CatalogStep,
  AI_CONFIG: AiConfigStep,
  TEAM: TeamStep,
  TEST: TestStep,
};
