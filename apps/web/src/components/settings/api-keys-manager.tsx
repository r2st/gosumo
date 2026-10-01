'use client';

import { useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/use-integrations';
import { usePermissions } from '@/hooks/use-permissions';
import { formatDateIST, timeAgo } from '@/lib/format';
import type { ApiKey, CreatedApiKey } from '@/lib/integration-types';

const SCOPES = [
  { value: 'conversations:read', label: 'Read conversations' },
  { value: 'conversations:write', label: 'Send messages' },
  { value: 'clients:read', label: 'Read clients' },
  { value: 'orders:read', label: 'Read orders' },
  { value: 'orders:write', label: 'Manage orders' },
  { value: 'analytics:read', label: 'Read analytics' },
];

export function ApiKeysManager() {
  const { data, isLoading, isError, error, refetch } = useApiKeys();
  const revoke = useRevokeApiKey();
  // POST /integrations/api-keys and DELETE /integrations/api-keys/:id are both
  // @Roles(MANAGER). Listing keys stays open — only minting and revoking are gated.
  const { canManage } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null);

  return (
    <SettingsCard
      title="GoSumo API keys"
      description="Authenticate programmatic access to the GoSumo API. Treat keys like passwords."
    >
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> Generate key
          </Button>
        </div>
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Generate a key to call the GoSumo API from your own systems."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Name</TH>
                <TH>Key</TH>
                <TH>Scopes</TH>
                <TH>Last used</TH>
                <TH>Created</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {data.data.map((key) => {
                // Revoking hard-deletes the row, so a revoked key never reaches
                // this list. Expiry is the only lifecycle state that shows up
                // here: the key is still listed but no longer authenticates.
                const expired = !!key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
                return (
                  <TR key={key.id} className={expired ? 'opacity-60' : undefined}>
                    <TD className="font-medium">{key.name}</TD>
                    <TD>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {key.prefix}••••{key.last4}
                      </code>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.length === 0 ? (
                          <Badge tone="neutral">full access</Badge>
                        ) : (
                          key.scopes.slice(0, 3).map((s) => (
                            <Badge key={s} tone="neutral">
                              {s}
                            </Badge>
                          ))
                        )}
                        {key.scopes.length > 3 && (
                          <Badge tone="neutral">+{key.scopes.length - 3}</Badge>
                        )}
                      </div>
                    </TD>
                    <TD className="text-muted-foreground">
                      {key.lastUsedAt ? timeAgo(key.lastUsedAt) : 'never'}
                    </TD>
                    <TD className="text-muted-foreground">{formatDateIST(key.createdAt)}</TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {expired && <Badge tone="danger">Expired</Badge>}
                        {canManage && (
                          <button
                            onClick={() => setToRevoke(key)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-danger"
                            aria-label={`Revoke ${key.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}

      <CreateKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={setCreated}
      />
      <RevealKeyModal created={created} onClose={() => setCreated(null)} />

      <Modal
        open={!!toRevoke}
        onClose={() => setToRevoke(null)}
        title="Revoke API key"
        description={toRevoke ? `“${toRevoke.name}” will stop working immediately.` : ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setToRevoke(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() =>
                toRevoke && revoke.mutate(toRevoke.id, { onSuccess: () => setToRevoke(null) })
              }
            >
              Revoke key
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Any integration using this key will start receiving 401 errors. This cannot be undone.
        </p>
      </Modal>
    </SettingsCard>
  );
}

function CreateKeyModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['conversations:read']);

  const toggle = (scope: string) =>
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, scopes },
      {
        onSuccess: (key) => {
          onCreated(key);
          setName('');
          setScopes(['conversations:read']);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate API key"
      description="Scope the key to only what it needs."
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-key-form"
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Generate
          </Button>
        </>
      }
    >
      <form id="create-key-form" onSubmit={submit} className="space-y-4">
        <Field label="Key name" hint="A label to recognise this key later, e.g. “Zapier sync”.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My integration"
            required
          />
        </Field>
        <Field label="Scopes">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label
                key={s.value}
                className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(s.value)}
                  onChange={() => toggle(s.value)}
                  className="h-4 w-4 accent-primary"
                />
                {s.label}
              </label>
            ))}
          </div>
        </Field>
        {create.isError && (
          <p className="text-sm text-danger">Couldn’t generate the key. Please try again.</p>
        )}
      </form>
    </Modal>
  );
}

function RevealKeyModal({
  created,
  onClose,
}: {
  created: CreatedApiKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!created) return;
    void navigator.clipboard?.writeText(created.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      open={!!created}
      onClose={onClose}
      title="Copy your API key"
      description="This is the only time the full key is shown."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-amber-400">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Store this somewhere safe. For security, we don’t keep a copy — if you lose it, generate
            a new one.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <code className="flex-1 break-all font-mono text-xs">{created?.secret}</code>
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
