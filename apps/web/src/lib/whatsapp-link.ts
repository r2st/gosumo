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
