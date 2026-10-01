'use client';

import { CreditCard, IndianRupee, Mail, MessageCircle, MessageSquare } from 'lucide-react';
import { useIntegrationCredentials } from '@/hooks/use-integrations';
import { IntegrationCard, type IntegrationDef } from '@/components/settings/integration-card';
import { ApiKeysManager } from '@/components/settings/api-keys-manager';
import { LoadingState, ErrorState } from '@/components/ui/states';

const PAYMENTS: IntegrationDef[] = [
  {
    provider: 'RAZORPAY',
    label: 'Razorpay',
    blurb: 'Accept UPI, cards and netbanking from Indian customers.',
    icon: IndianRupee,
    color: 'bg-[#0c2451]',
    fields: [
      { name: 'keyId', label: 'Key ID', placeholder: 'rzp_live_…' },
      { name: 'keySecret', label: 'Key secret', secret: true },
    ],
  },
  {
    provider: 'STRIPE',
    label: 'Stripe',
    blurb: 'Accept international card payments.',
    icon: CreditCard,
    color: 'bg-[#635bff]',
    fields: [
      { name: 'publishableKey', label: 'Publishable key', placeholder: 'pk_live_…' },
      { name: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_…' },
    ],
  },
];

const MESSAGING: IntegrationDef[] = [
  {
    provider: 'WHATSAPP',
    label: 'WhatsApp Business API',
    blurb: 'Send and receive WhatsApp messages via Meta Cloud API.',
    icon: MessageCircle,
    color: 'bg-[#25D366]',
    fields: [
      { name: 'appId', label: 'Meta App ID', placeholder: '1234567890' },
      { name: 'phoneNumberId', label: 'Phone number ID', placeholder: '1098765…' },
      { name: 'accessToken', label: 'Access token', secret: true, hint: 'Permanent token from Meta Business Manager.' },
    ],
  },
  {
    provider: 'SMS',
    label: 'SMS provider',
    blurb: 'Send transactional SMS via Twilio or MSG91.',
    icon: MessageSquare,
    color: 'bg-sky-500',
    fields: [
      {
        name: 'subProvider',
        label: 'Provider',
        options: [
          { label: 'Twilio', value: 'TWILIO' },
          { label: 'MSG91', value: 'MSG91' },
        ],
      },
      { name: 'twilioAccountSid', label: 'Account SID', placeholder: 'AC…', visibleWhen: { field: 'subProvider', equals: 'TWILIO' } },
      { name: 'twilioAuthToken', label: 'Auth token', secret: true, visibleWhen: { field: 'subProvider', equals: 'TWILIO' } },
      { name: 'twilioPhoneNumber', label: 'Phone number', placeholder: '+1…', visibleWhen: { field: 'subProvider', equals: 'TWILIO' } },
      { name: 'msg91AuthKey', label: 'Auth key', secret: true, visibleWhen: { field: 'subProvider', equals: 'MSG91' } },
      { name: 'msg91SenderId', label: 'Sender ID', placeholder: 'GOSUMO', visibleWhen: { field: 'subProvider', equals: 'MSG91' } },
    ],
  },
];

const EMAIL: IntegrationDef[] = [
  {
    provider: 'SMTP',
    label: 'SMTP',
    blurb: 'Send email through your own mail server.',
    icon: Mail,
    color: 'bg-amber-500',
    fields: [
      { name: 'host', label: 'Host', placeholder: 'smtp.gmail.com' },
      { name: 'port', label: 'Port', type: 'number', placeholder: '587' },
      { name: 'username', label: 'Username', placeholder: 'you@business.in' },
      { name: 'password', label: 'Password', secret: true },
      { name: 'fromEmail', label: 'From email', type: 'email', placeholder: 'no-reply@business.in' },
    ],
  },
];

export default function ApiKeysPage() {
  const { data: creds, isLoading, isError, error, refetch } = useIntegrationCredentials();

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Bring your own credentials for the services DoAide Desk uses on your behalf. Secrets are encrypted at rest and never
        shown again after saving.
      </p>

      <Group title="Payments">
        {PAYMENTS.map((def) => (
          <IntegrationCard key={def.provider} def={def} credential={creds?.[def.provider]} />
        ))}
      </Group>

      <Group title="Messaging">
        {MESSAGING.map((def) => (
          <IntegrationCard key={def.provider} def={def} credential={creds?.[def.provider]} />
        ))}
      </Group>

      <Group title="Email">
        {EMAIL.map((def) => (
          <IntegrationCard key={def.provider} def={def} credential={creds?.[def.provider]} />
        ))}
      </Group>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Developer</h2>
        <ApiKeysManager />
      </section>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
