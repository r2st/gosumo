'use client';

import { useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, LinkIcon } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Avatar } from '@/components/ui/avatar';
import { useClients } from '@/hooks/use-queries';
import { useCreatePaymentLink } from '@/hooks/use-payments';
import { rupeesToPaise } from '@/lib/money';
import { paiseToRupees } from '@/lib/format';
import type { PaymentLinkResponse } from '@/lib/commerce-types';

export function CreatePaymentLinkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreatePaymentLink();

  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expiresInHours, setExpiresInHours] = useState('24');
  const [sendToClient, setSendToClient] = useState(true);
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [result, setResult] = useState<PaymentLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const clientsQ = useClients({ q: clientQuery || undefined, limit: 6 });
  const clients = clientsQ.data?.data ?? [];

  const reset = () => {
    setClientId('');
    setClientName('');
    setClientQuery('');
    setAmount('');
    setDescription('');
    setExpiresInHours('24');
    setSendToClient(true);
    setAcceptPartial(false);
    setResult(null);
    setCopied(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clientId || !amount || !description.trim()) return;
    create.mutate(
      {
        clientId,
        amount: rupeesToPaise(amount),
        description: description.trim(),
        expiresInHours: Number(expiresInHours) || 24,
        sendToClient,
        acceptPartialPayments: acceptPartial,
      },
      { onSuccess: setResult },
    );
  };

  const copy = () => {
    const url = result?.link.shortUrl ?? result?.link.url;
    if (!url) return;
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // After creation, show the link.
  if (result) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Payment link ready"
        description={result.messageSent ? 'The link was sent to the client.' : 'Share this link with your client.'}
        footer={<Button onClick={close}>Done</Button>}
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">Amount</p>
            <p className="text-lg font-bold">{paiseToRupees(result.payment.amount)}</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border p-3">
            <code className="flex-1 break-all font-mono text-xs">{result.link.shortUrl ?? result.link.url}</code>
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <a href={result.link.url} target="_blank" rel="noreferrer" className="inline-flex">
              <Button type="button" variant="ghost" size="icon" aria-label="Open link">
                <ExternalLink className="h-4 w-4" />
              </Button>
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Generate payment link"
      description="Create a Razorpay link and optionally send it to the client."
      footer={
        <>
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="link-form" loading={create.isPending} disabled={!clientId || !amount || !description.trim()}>
            <LinkIcon className="h-4 w-4" /> Create link
          </Button>
        </>
      }
    >
      <form id="link-form" onSubmit={submit} className="space-y-4">
        <Field label="Client">
          {clientId ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-success" /> {clientName}
              </span>
              <button
                type="button"
                onClick={() => {
                  setClientId('');
                  setClientName('');
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Input value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Search client by name, phone…" />
              {clientQuery && (
                <div className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {clients.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No matching clients.</p>
                  ) : (
                    clients.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setClientId(c.id);
                          setClientName(c.name);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <Avatar name={c.name} src={c.avatarUrl} size="sm" />
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto truncate text-xs text-muted-foreground">{c.phone ?? c.email}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (₹)">
            <Input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Expires in (hours)">
            <Select
              value={expiresInHours}
              onChange={(e) => setExpiresInHours(e.target.value)}
              options={[
                { label: '1 hour', value: '1' },
                { label: '6 hours', value: '6' },
                { label: '24 hours', value: '24' },
                { label: '3 days', value: '72' },
                { label: '7 days', value: '168' },
              ]}
            />
          </Field>
        </div>

        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this payment for?" required />
        </Field>

        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Switch checked={sendToClient} onChange={setSendToClient} label="Send to client" description="Deliver via the client’s preferred channel." />
          <Switch checked={acceptPartial} onChange={setAcceptPartial} label="Accept partial payments" description="Let the client pay in instalments." />
        </div>

        {create.isError && <p className="text-sm text-danger">Couldn’t create the payment link. Please try again.</p>}
      </form>
    </Modal>
  );
}
