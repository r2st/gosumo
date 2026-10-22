/**
 * Build a wa.me deep link that opens WhatsApp on the agent's device with
 * a pre-filled message. No Meta Business API key required — works with the
 * agent's personal or business WhatsApp.
 *
 * @see https://faq.whatsapp.com/5913398998672934
 */
export function buildWhatsAppLink(phone: string, message?: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return '';
  const url = `https://wa.me/${digits}`;
  if (!message) return url;
  return `${url}?text=${encodeURIComponent(message)}`;
}

export function openWhatsApp(phone: string, message?: string): void {
  const url = buildWhatsAppLink(phone, message);
  if (url) window.open(url, '_blank', 'noopener');
}

const STATUS_COPY: Record<string, string> = {
  OPEN: 'is open and with our team',
  PENDING: 'is waiting on a reply from you',
  ESCALATED: 'has been passed to a senior team member',
  BOT_HANDLING: 'is being handled by our assistant',
  RESOLVED: 'has been resolved',
};

/** Pre-filled WhatsApp text telling a customer where their ticket stands. */
export function ticketStatusMessage(name: string | null | undefined, status: string): string {
  const greeting = name?.trim() ? `Hi ${name.trim()},` : 'Hi,';
  const where = STATUS_COPY[status] ?? 'has been updated';
  const tail = status === 'RESOLVED'
    ? 'Reply here if anything is still not right.'
    : 'We will keep you posted here.';
  return `${greeting} your support request ${where}. ${tail}`;
}

/** Pre-filled text an operator shares so customers can raise a ticket without signing up. */
export function supportLinkMessage(link: string): string {
  return `Need help? Raise a support ticket here — no sign-up needed: ${link}`;
}

/** `wa.me` share link with no recipient: WhatsApp asks who to send it to. */
export function buildWhatsAppShareLink(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
