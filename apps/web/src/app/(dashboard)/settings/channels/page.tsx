'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Instagram,
  Mail,
  MessageCircle,
  Phone,
  Plug,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { useChannels, useConnectChannel, useDisconnectChannel } from '@/hooks/use-settings';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { ChannelIcon, channelLabel } from '@/components/channel-icon';
import { cn } from '@/lib/utils';
import { humanizeEnum, timeAgo } from '@/lib/format';
import type { Channel, ChannelStatus } from '@/lib/feature-types';
import type { ChannelType } from '@/lib/types';

interface FieldDef {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  options?: string[];
}

interface ChannelDef {
  type: ChannelType;
  label: string;
  blurb: string;
  icon: LucideIcon;
  color: string;
  connectPath: string;
  fields: FieldDef[];
}

const CHANNELS: ChannelDef[] = [
  {
    type: 'WHATSAPP',
    label: 'WhatsApp',
    blurb: 'Connect your WhatsApp Business number via Meta.',
    icon: MessageCircle,
    color: 'bg-[#25D366]',
    connectPath: '/channels/whatsapp/connect',
    fields: [
      { name: 'displayName', label: 'Display name', placeholder: 'Main WhatsApp' },
      { name: 'phoneNumberId', label: 'Phone Number ID' },
      { name: 'wabaId', label: 'WhatsApp Business Account ID' },
      { name: 'accessToken', label: 'Meta access token', type: 'password' },
    ],
  },
  {
    type: 'INSTAGRAM',
    label: 'Instagram',
    blurb: 'Reply to Instagram DMs from a linked Facebook Page.',
    icon: Instagram,
    color: 'bg-[#E1306C]',
    connectPath: '/channels/instagram/connect',
    fields: [
      { name: 'displayName', label: 'Display name', placeholder: 'Instagram DMs' },
      { name: 'pageId', label: 'Facebook Page ID' },
      { name: 'accessToken', label: 'Page access token', type: 'password' },
    ],
  },
  {
    type: 'SMS',
    label: 'SMS',
    blurb: 'Send and receive SMS via your gateway provider.',
    icon: Phone,
    color: 'bg-sky-500',
    connectPath: '/channels/sms/connect',
    fields: [
      { name: 'displayName', label: 'Display name', placeholder: 'SMS' },
      { name: 'provider', label: 'Provider', options: ['TWILIO', 'KALEYRA', 'MSG91'] },
      { name: 'phoneNumber', label: 'Sender number (E.164)', placeholder: '+91…' },
      { name: 'apiKey', label: 'API key', type: 'password' },
    ],
  },
  {
    type: 'WEB_CHAT',
    label: 'Web Chat',
    blurb: 'Embed a chat widget on your website.',
    icon: Globe,
    color: 'bg-violet-600',
    connectPath: '/channels/web-chat/connect',
    fields: [
      { name: 'displayName', label: 'Display name', placeholder: 'Website chat' },
      { name: 'title', label: 'Widget title', placeholder: 'Chat with us' },
      { name: 'primaryColor', label: 'Primary colour', placeholder: '#4f46e5' },
    ],
  },
  {
    type: 'EMAIL',
    label: 'Email',
    blurb: 'Handle customer emails over SMTP / IMAP.',
    icon: Mail,
    color: 'bg-amber-500',
    connectPath: '/channels/email/connect',
    fields: [
      { name: 'displayName', label: 'Display name', placeholder: 'Support inbox' },
      { name: 'fromEmail', label: 'From email', type: 'email', placeholder: 'support@business.in' },
      { name: 'fromName', label: 'From name', placeholder: 'Business Support' },
    ],
  },
];

const STATUS: Record<ChannelStatus, { tone: BadgeTone; label: string }> = {
  CONNECTED: { tone: 'success', label: 'Connected' },
  DISCONNECTED: { tone: 'neutral', label: 'Disconnected' },
  PENDING: { tone: 'warning', label: 'Pending' },
  ERROR: { tone: 'danger', label: 'Error' },
  RATE_LIMITED: { tone: 'warning', label: 'Rate limited' },
};

export default function ChannelsPage() {
  const { data, isLoading, isError, refetch } = useChannels();
  const disconnect = useDisconnectChannel();
  const [connectDef, setConnectDef] = useState<ChannelDef | null>(null);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState onRetry={() => void refetch()} />;

  const connected = data.data;
  const connectedTypes = new Set(connected.map((c) => c.type));

  return (
    <>
      {connected.length > 0 && (
        <SettingsCard title="Connected channels" description="Channels currently routing messages into GoSumo.">
          <div className="space-y-2">
            {connected.map((channel) => (
              <div key={channel.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <ChannelIcon channel={channel.type} className="h-9 w-9" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{channel.displayName}</p>
                    <Badge tone={STATUS[channel.status].tone}>{STATUS[channel.status].label}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {channelLabel(channel.type)} · {channel.accountId}
                    {channel.lastMessageAt ? ` · last message ${timeAgo(channel.lastMessageAt)}` : ''}
                  </p>
                  {channel.status === 'ERROR' && channel.errorMessage && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
                      <AlertTriangle className="h-3 w-3" /> {channel.errorMessage}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="outline" loading={disconnect.isPending} onClick={() => disconnect.mutate(channel.id)}>
                  <Unplug className="h-3.5 w-3.5" /> Disconnect
                </Button>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Available channels" description="Connect a new channel to start receiving messages.">
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((def) => {
            const Icon = def.icon;
            const isConnected = connectedTypes.has(def.type);
            return (
              <div key={def.type} className="flex items-start gap-3 rounded-lg border border-border p-3.5">
                <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white', def.color)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{def.label}</p>
                    {isConnected && (
                      <Badge tone="success">
                        <CheckCircle2 className="h-3 w-3" /> Active
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{def.blurb}</p>
                  <Button size="sm" variant={isConnected ? 'outline' : 'primary'} className="mt-2.5" onClick={() => setConnectDef(def)}>
                    <Plug className="h-3.5 w-3.5" /> {isConnected ? 'Add another' : 'Connect'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <ConnectModal def={connectDef} onClose={() => setConnectDef(null)} />
    </>
  );
}

function ConnectModal({ def, onClose }: { def: ChannelDef | null; onClose: () => void }) {
  const connect = useConnectChannel();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => setValues({}), [def]);

  if (!def) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate({ path: def.connectPath, body: buildConnectBody(def.type, values) }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={!!def}
      onClose={onClose}
      title={`Connect ${def.label}`}
      description={def.blurb}
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="connect-form" loading={connect.isPending}>
            Connect
          </Button>
        </>
      }
    >
      <form id="connect-form" onSubmit={submit} className="space-y-4">
        {def.fields.map((f) => (
          <Field key={f.name} label={f.label}>
            {f.options ? (
              <Select
                options={[{ label: 'Select…', value: '' }, ...f.options.map((o) => ({ label: humanizeEnum(o), value: o }))]}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            ) : (
              <Input
                type={f.type ?? 'text'}
                value={values[f.name] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                required
              />
            )}
          </Field>
        ))}
        {connect.isError && <p className="text-sm text-danger">Connection failed. Double-check your credentials.</p>}
      </form>
    </Modal>
  );
}

function buildConnectBody(type: ChannelType, v: Record<string, string>): Record<string, unknown> {
  switch (type) {
    case 'SMS':
      return { displayName: v.displayName, provider: v.provider, phoneNumber: v.phoneNumber, credentials: { apiKey: v.apiKey } };
    case 'WEB_CHAT':
      return {
        displayName: v.displayName,
        widgetConfig: { title: v.title, primaryColor: v.primaryColor || '#4f46e5', position: 'BOTTOM_RIGHT', allowedOrigins: [] },
      };
    case 'EMAIL':
      return { displayName: v.displayName, fromEmail: v.fromEmail, fromName: v.fromName, smtp: {} };
    default:
      return v;
  }
}
