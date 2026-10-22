'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  MAX_DESCRIPTION_CHARS,
  TICKET_PRIORITIES,
  TicketSubmitError,
  formatTicketMessage,
  submitTicket,
  ticketWhatsAppText,
  validateTicket,
  type TicketErrors,
  type TicketInput,
} from '@/lib/support-ticket';

const EMPTY: TicketInput = { name: '', contact: '', subject: '', description: '', priority: 'Normal' };

const inputClass =
  'w-full min-h-[48px] rounded-lg border border-[var(--da-border)] bg-[var(--da-surface)] px-3 py-2 text-base text-[var(--da-text)] placeholder:text-[var(--da-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--da-primary)]';

/**
 * Which business's inbox a ticket goes to. `?w=<web-chat channel id>` is what
 * an operator shares with their customers; without it the page files tickets
 * with DoAide Desk's own support widget when one is configured.
 */
function resolveWidgetId(param: string | null): string {
  return (param ?? '').trim() || (process.env.NEXT_PUBLIC_SUPPORT_WIDGET_ID ?? '').trim();
}

/** No widget to file against: hand the ticket to the site feedback endpoint instead. */
async function submitAsFeedback(input: TicketInput): Promise<{ reference: string }> {
  const reference = Date.now().toString(36).toUpperCase();
  const contact = input.contact.trim();
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'general',
      message: `[#${reference}] ${formatTicketMessage(input)}`,
      email: contact.includes('@') ? contact : undefined,
      url: window.location.href,
    }),
  });
  if (!res.ok) throw new TicketSubmitError('Your ticket was not accepted. Please check the form and try again.');
  return { reference };
}

export function SupportForm() {
  const params = useSearchParams();
  const widgetId = resolveWidgetId(params?.get('w') ?? null);

  const [input, setInput] = useState<TicketInput>(EMPTY);
  const [errors, setErrors] = useState<TicketErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string; ticket: TicketInput } | null>(null);

  const set = <K extends keyof TicketInput>(key: K, value: TicketInput[K]) => {
    setInput((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateTicket(input);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '';
      const result = widgetId && wsUrl
        ? await submitTicket({ wsUrl, widgetId, input })
        : await submitAsFeedback(input);
      setDone({ reference: result.reference, ticket: input });
      setInput(EMPTY);
    } catch (err) {
      setSubmitError(
        err instanceof TicketSubmitError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    const pageUrl = typeof window !== 'undefined' ? window.location.href : 'https://desk.doaide.com/support';
    const waText = ticketWhatsAppText(done.ticket, done.reference, pageUrl);
    return (
      <div className="rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] p-6 text-center" role="status">
        <h1 className="text-2xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
          Ticket received
        </h1>
        <p className="text-[var(--da-text-secondary)] mb-1">Your reference number is</p>
        <p className="text-3xl font-mono font-bold text-[var(--da-primary)] mb-4">#{done.reference}</p>
        <p className="text-sm text-[var(--da-text-muted)] mb-6">
          We will reply on {done.ticket.contact}. Quote this number if you follow up.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href={`https://wa.me/?text=${encodeURIComponent(waText)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-white no-underline hover:opacity-90"
          >
            Save to WhatsApp
          </a>
          <button
            type="button"
            onClick={() => setDone(null)}
            className="inline-flex min-h-[48px] items-center justify-center rounded-lg border border-[var(--da-border)] px-5 text-sm font-medium text-[var(--da-text)] hover:bg-[var(--da-surface-hover)]"
          >
            Raise another ticket
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl sm:text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Raise a support ticket
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        No account needed. Tell us what is wrong and you will get a reference number straight away.
      </p>

      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <TicketField id="ticket-name" label="Your name" error={errors.name}>
          <input id="ticket-name" className={inputClass} autoComplete="name" value={input.name} onChange={(e) => set('name', e.target.value)} />
        </TicketField>
        <TicketField id="ticket-contact" label="Email or phone" hint="We reply here — nothing else." error={errors.contact}>
          <input id="ticket-contact" className={inputClass} autoComplete="email" inputMode="email" value={input.contact} onChange={(e) => set('contact', e.target.value)} />
        </TicketField>
        <TicketField id="ticket-subject" label="Subject" error={errors.subject}>
          <input id="ticket-subject" className={inputClass} maxLength={120} value={input.subject} onChange={(e) => set('subject', e.target.value)} />
        </TicketField>
        <TicketField id="ticket-priority" label="How urgent is it?">
          <select id="ticket-priority" className={inputClass} value={input.priority} onChange={(e) => set('priority', e.target.value as TicketInput['priority'])}>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </TicketField>
        <TicketField
          id="ticket-description"
          label="What happened?"
          hint={`${input.description.length}/${MAX_DESCRIPTION_CHARS}`}
          error={errors.description}
        >
          <textarea
            id="ticket-description"
            rows={6}
            maxLength={MAX_DESCRIPTION_CHARS}
            className={`${inputClass} resize-y`}
            value={input.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </TicketField>

        {submitError && (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full min-h-[48px] rounded-lg bg-[var(--da-primary)] px-5 text-base font-semibold text-[var(--da-text-on-primary)] hover:bg-[var(--da-primary-hover)] disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Submit ticket'}
        </button>
      </form>
    </div>
  );
}

function TicketField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-[var(--da-text)]">{label}</label>
        {hint && <span className="text-xs text-[var(--da-text-muted)]">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="mt-1 text-sm text-red-500" id={`${id}-error`}>{error}</p>
      )}
    </div>
  );
}
