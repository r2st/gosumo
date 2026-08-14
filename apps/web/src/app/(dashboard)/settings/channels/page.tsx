'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Code2,
  Copy,
  Globe,
  Instagram,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Plug,
  ShieldCheck,
  Unplug,
  Wifi,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useChannels, useConnectChannel, useDisconnectChannel } from '@/hooks/use-settings';
import { useTestChannel, useWebChatEmbed, useToggleChannel } from '@/hooks/use-channels';
import { usePermissions } from '@/hooks/use-permissions';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { ChannelIcon, channelLabel } from '@/components/channel-icon';
import { cn } from '@/lib/utils';
import { humanizeEnum, timeAgo } from '@/lib/format';
import type { Channel, ChannelStatus } from '@/lib/feature-types';
import type { ChannelType } from '@/lib/types';

/* ─── Field / channel definitions ─────────────────────────────────────────── */

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
      { name: 'accountSid', label: 'Account SID' },
      { name: 'authToken', label: 'Auth token', type: 'password' },
    ],
  },
  {
    type: 'WEB_CHAT',
    label: 'Web Chat',
    blurb: 'Embed a chat widget on your website.',
    icon: Globe,
    color: 'bg-violet-600',
    connectPath: '/channels/web_chat/connect',
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
      { name: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.gmail.com' },
      { name: 'smtpPort', label: 'SMTP port', placeholder: '587' },
      { name: 'smtpUser', label: 'SMTP user', placeholder: 'support@business.in' },
      { name: 'smtpPass', label: 'SMTP password', type: 'password' },
      { name: 'imapHost', label: 'IMAP host', placeholder: 'imap.gmail.com' },
      { name: 'imapPort', label: 'IMAP port', placeholder: '993' },
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

const WEBHOOK_CHANNELS: ChannelType[] = ['WHATSAPP', 'INSTAGRAM', 'SMS'];

/** Mask a credential string, showing only the last 4 chars. */
function maskCredential(value: string): string {
  if (!value || value.length < 6) return '••••••••';
  return '••••••••' + value.slice(-4);
}

/** Extract a display-worthy credential hint from channel metadata. */
function getCredentialHint(channel: Channel): string | null {
  const meta = channel.metadata;
  if (!meta) return null;
  const token =
    (meta.accessTokenLast4 as string) ??
    (meta.apiKeyLast4 as string) ??
    (meta.credentialHint as string);
  if (token) return `Access token: ${maskCredential(token)}`;
  return null;
}

/* ─── Main page ───────────────────────────────────────────────────────────── */

export default function ChannelsPage() {
  const { data, isLoading, isError, refetch } = useChannels();
  const disconnect = useDisconnectChannel();
  const toggleChannel = useToggleChannel();
  // Connect, disconnect and test are @Roles(MANAGER); the enable/disable
  // toggle is an undecorated write, so it only needs STAFF.
  const { canManage, canWrite } = usePermissions();
  const testChannel = useTestChannel();
  const embedMutation = useWebChatEmbed();

  const [connectDef, setConnectDef] = useState<ChannelDef | null>(null);
  const [embedModalId, setEmbedModalId] = useState<string | null>(null);
  const [embedSnippet, setEmbedSnippet] = useState<string | null>(null);

  // Per-channel test results
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message: string; latencyMs: number } | null>
  >({});
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  // Clipboard helpers — multiple independent copy states
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const handleTest = (channelId: string) => {
    setTestingIds((prev) => new Set(prev).add(channelId));
    setTestResults((prev) => ({ ...prev, [channelId]: null }));
    testChannel.mutate(channelId, {
      onSuccess: (result) => {
        setTestResults((prev) => ({ ...prev, [channelId]: result }));
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
      },
      onError: () => {
        setTestResults((prev) => ({
          ...prev,
          [channelId]: { success: false, message: 'Test request failed', latencyMs: 0 },
        }));
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
      },
    });
  };

  const handleGetEmbed = (channelId: string) => {
    setEmbedModalId(channelId);
    setEmbedSnippet(null);
    embedMutation.mutate(channelId, {
      onSuccess: (result) => setEmbedSnippet(result.snippet),
    });
  };

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState onRetry={() => void refetch()} />;

  const connected = data.data;
  const connectedTypes = new Set(connected.map((c) => c.type));

  return (
    <>
      {/* ── Connected channels ──────────────────────────────────────────── */}
      {connected.length > 0 && (
        <SettingsCard
          title="Connected channels"
          description="Channels currently routing messages into GoSumo."
        >
          <div className="space-y-3">
            {connected.map((channel) => {
              const isTesting = testingIds.has(channel.id);
              const testResult = testResults[channel.id] ?? null;
              const showWebhook = WEBHOOK_CHANNELS.includes(channel.type) && channel.webhookUrl;
              const credentialHint = getCredentialHint(channel);
              const isEnabled = channel.status === 'CONNECTED';

              return (
                <div key={channel.id} className="rounded-lg border border-border p-3">
                  {/* Row 1: icon + name + badge */}
                  <div className="flex items-center gap-3">
                    <ChannelIcon channel={channel.type} className="h-9 w-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">{channel.displayName}</p>
                        <Badge tone={STATUS[channel.status].tone}>
                          {STATUS[channel.status].label}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {channelLabel(channel.type)} · {channel.accountId}
                        {channel.lastMessageAt
                          ? ` · last message ${timeAgo(channel.lastMessageAt)}`
                          : ''}
                      </p>
                      {channel.status === 'ERROR' && channel.errorMessage && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
                          <AlertTriangle className="h-3 w-3" /> {channel.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Webhook URL (WhatsApp, Instagram, SMS) */}
                  {showWebhook && (
                    <div className="mt-2.5 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Webhook URL
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                          {channel.webhookUrl}
                        </code>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            copyToClipboard(channel.webhookUrl, `webhook-${channel.id}`)
                          }
                        >
                          {copiedKey === `webhook-${channel.id}` ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" /> Copy URL
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Credential hint */}
                  {credentialHint && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{credentialHint} · stored securely</span>
                    </div>
                  )}

                  {/* Action row: Test | Embed | Disconnect + Toggle */}
                  <div className="mt-3 flex items-center gap-2">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={isTesting}
                        onClick={() => handleTest(channel.id)}
                      >
                        <Wifi className="h-3.5 w-3.5" /> Test
                      </Button>
                    )}

                    {channel.type === 'WEB_CHAT' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleGetEmbed(channel.id)}
                      >
                        <Code2 className="h-3.5 w-3.5" /> Get Embed Code
                      </Button>
                    )}

                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={disconnect.isPending}
                        onClick={() => disconnect.mutate(channel.id)}
                      >
                        <Unplug className="h-3.5 w-3.5" /> Disconnect
                      </Button>
                    )}

                    {/* PATCH /channels/:id/toggle carries no @Roles(), so it
                        falls to the guard's STAFF+ default — a rung lower than
                        connect and disconnect. */}
                    {canWrite && (
                      <div className="ml-auto">
                        <Switch
                          checked={isEnabled}
                          onChange={(next) =>
                            toggleChannel.mutate({ channelId: channel.id, enabled: next })
                          }
                          disabled={toggleChannel.isPending}
                          ariaLabel={`${channel.displayName} enabled`}
                        />
                      </div>
                    )}
                  </div>

                  {/* Test result inline feedback */}
                  {testResult && (
                    <div
                      className={cn(
                        'mt-2 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                        testResult.success
                          ? 'bg-success/10 text-success'
                          : 'bg-danger/10 text-danger',
                      )}
                    >
                      {testResult.success ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      {testResult.success
                        ? `Connection verified (${testResult.latencyMs}ms)`
                        : testResult.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SettingsCard>
      )}

      {/* ── Available channels ──────────────────────────────────────────── */}
      <SettingsCard
        title="Available channels"
        description="Connect a new channel to start receiving messages."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((def) => {
            const Icon = def.icon;
            const isConnected = connectedTypes.has(def.type);
            return (
              <div
                key={def.type}
                className="flex items-start gap-3 rounded-lg border border-border p-3.5"
              >
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white',
                    def.color,
                  )}
                >
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
                  {canManage && (
                    <Button
                      size="sm"
                      variant={isConnected ? 'outline' : 'primary'}
                      className="mt-2.5"
                      onClick={() => setConnectDef(def)}
                    >
                      <Plug className="h-3.5 w-3.5" /> {isConnected ? 'Add another' : 'Connect'}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      {/* ── Connect modal ───────────────────────────────────────────────── */}
      <ConnectModal def={connectDef} onClose={() => setConnectDef(null)} />

      {/* ── Embed code modal (WEB_CHAT) ─────────────────────────────────── */}
      <EmbedModal
        open={!!embedModalId}
        snippet={embedSnippet}
        loading={embedMutation.isPending}
        error={embedMutation.isError}
        onClose={() => {
          setEmbedModalId(null);
          setEmbedSnippet(null);
        }}
        onCopy={(text) => copyToClipboard(text, 'embed-snippet')}
        copied={copiedKey === 'embed-snippet'}
      />
    </>
  );
}

/* ─── Connect modal ───────────────────────────────────────────────────────── */

function ConnectModal({ def, onClose }: { def: ChannelDef | null; onClose: () => void }) {
  const connect = useConnectChannel();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => setValues({}), [def]);

  if (!def) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate(
      { path: def.connectPath, body: buildConnectBody(def.type, values) },
      { onSuccess: onClose },
    );
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
                options={[
                  { label: 'Select…', value: '' },
                  ...f.options.map((o) => ({ label: humanizeEnum(o), value: o })),
                ]}
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
        {connect.isError && (
          <p className="text-sm text-danger">Connection failed. Double-check your credentials.</p>
        )}
      </form>
    </Modal>
  );
}

/* ─── Embed code modal ────────────────────────────────────────────────────── */

function EmbedModal({
  open,
  snippet,
  loading,
  error,
  onClose,
  onCopy,
  copied,
}: {
  open: boolean;
  snippet: string | null;
  loading: boolean;
  error: boolean;
  onClose: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Web Chat Embed Code"
      description="Paste this snippet into your website's HTML, just before the closing </body> tag."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {snippet && (
            <Button variant="primary" onClick={() => onCopy(snippet)}>
              <ClipboardCopy className="h-3.5 w-3.5" /> {copied ? 'Copied!' : 'Copy Snippet'}
            </Button>
          )}
        </>
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <p className="text-sm text-danger">Failed to fetch embed snippet. Please try again.</p>
      )}
      {snippet && (
        <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-relaxed">
          <code>{snippet}</code>
        </pre>
      )}
    </Modal>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function buildConnectBody(type: ChannelType, v: Record<string, string>): Record<string, unknown> {
  switch (type) {
    case 'SMS':
      return {
        displayName: v.displayName,
        provider: v.provider,
        phoneNumber: v.phoneNumber,
        accountSid: v.accountSid,
        authToken: v.authToken,
      };
    case 'WEB_CHAT':
      return {
        displayName: v.displayName,
        title: v.title || 'Chat with us',
        primaryColor: v.primaryColor || '#4f46e5',
        widgetConfig: {
          title: v.title || 'Chat with us',
          primaryColor: v.primaryColor || '#4f46e5',
          position: 'BOTTOM_RIGHT',
          allowedOrigins: [],
        },
      };
    case 'EMAIL':
      return {
        displayName: v.displayName,
        fromEmail: v.fromEmail,
        fromName: v.fromName,
        smtp: {
          host: v.smtpHost,
          port: Number(v.smtpPort) || 587,
          user: v.smtpUser,
          pass: v.smtpPass,
          imap: { host: v.imapHost, port: Number(v.imapPort) || 993 },
        },
      };
    default:
      return v;
  }
}
