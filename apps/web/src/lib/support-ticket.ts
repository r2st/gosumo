import { io, type Socket } from 'socket.io-client';

/**
 * Login-free support tickets.
 *
 * A ticket is a web-chat conversation opened on the business's widget and
 * seeded with one structured message. That path is the API's existing
 * anonymous entry point — `chat:init` resolves the widget to its tenant and
 * creates the client and conversation, `chat:message` stores the text and
 * runs it through the normal AI/HITL pipeline — so a ticket lands in the
 * operator's inbox like any other conversation, with every throttle and
 * validation the gateway already applies. Nothing here needs a new public
 * HTTP route on the API.
 */

export const TICKET_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface TicketInput {
  name: string;
  contact: string;
  subject: string;
  description: string;
  priority: TicketPriority;
}

/** Mirrors `WEBCHAT_MAX_MESSAGE_CHARS` on the gateway, which rejects longer text. */
export const MAX_TICKET_MESSAGE_CHARS = 4096;
export const MAX_DESCRIPTION_CHARS = 3000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{8,15}$/;

export type TicketErrors = Partial<Record<keyof TicketInput, string>>;

export function validateTicket(input: TicketInput): TicketErrors {
  const errors: TicketErrors = {};
  if (!input.name.trim()) errors.name = 'Please tell us your name.';
  const contact = input.contact.trim();
  if (!contact) errors.contact = 'Add an email or phone number so we can reply.';
  else if (!EMAIL_RE.test(contact) && !PHONE_RE.test(contact)) {
    errors.contact = 'Enter a valid email or a 10-digit phone number.';
  }
  if (!input.subject.trim()) errors.subject = 'Add a short subject.';
  else if (input.subject.length > 120) errors.subject = 'Keep the subject under 120 characters.';
  if (input.description.trim().length < 10) {
    errors.description = 'Describe the issue in a sentence or two.';
  } else if (input.description.length > MAX_DESCRIPTION_CHARS) {
    errors.description = `Keep the description under ${MAX_DESCRIPTION_CHARS} characters.`;
  }
  return errors;
}

/** The single message the operator sees as the first turn of the conversation. */
export function formatTicketMessage(input: TicketInput): string {
  const text = [
    `Support ticket: ${input.subject.trim()}`,
    `Priority: ${input.priority}`,
    `From: ${input.name.trim()} (${input.contact.trim()})`,
    '',
    input.description.trim(),
  ].join('\n');
  return text.slice(0, MAX_TICKET_MESSAGE_CHARS);
}

/** Short, human-quotable reference derived from the stored message id. */
export function ticketReference(messageId: string): string {
  return messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
}

/** Text for the "save a copy to WhatsApp" link on the confirmation screen. */
export function ticketWhatsAppText(input: TicketInput, reference: string, pageUrl: string): string {
  return [
    `My support ticket #${reference}`,
    `Subject: ${input.subject.trim()}`,
    `Priority: ${input.priority}`,
    '',
    `Raise another ticket: ${pageUrl}`,
  ].join('\n');
}

export class TicketSubmitError extends Error {}

type SocketFactory = (url: string) => Socket;

const defaultFactory: SocketFactory = (url) =>
  io(url, { transports: ['websocket', 'polling'], reconnection: false, timeout: 10_000 });

/**
 * Open a web-chat session on `widgetId`, send the ticket as its first message
 * and resolve with a reference once the gateway acknowledges it.
 */
export function submitTicket(
  {
    wsUrl,
    widgetId,
    input,
    timeoutMs = 15_000,
  }: { wsUrl: string; widgetId: string; input: TicketInput; timeoutMs?: number },
  createSocket: SocketFactory = defaultFactory,
): Promise<{ reference: string }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(`${wsUrl.replace(/\/$/, '')}/webchat`);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.disconnect();
      fn();
    };
    const fail = (message: string) => finish(() => reject(new TicketSubmitError(message)));
    const timer = setTimeout(
      () => fail('We could not reach support right now. Please try again in a minute.'),
      timeoutMs,
    );

    socket.on('connect_error', () =>
      fail('We could not reach support right now. Please try again in a minute.'),
    );
    socket.on('connect', () => {
      socket.emit('chat:init', { widgetId }, (init: { sessionId?: string; greeting?: string }) => {
        if (!init?.sessionId) {
          fail(init?.greeting || 'This support link is not active. Please check it with the business.');
          return;
        }
        socket.emit(
          'chat:message',
          { sessionId: init.sessionId, text: formatTicketMessage(input) },
          (ack: { received?: boolean; messageId?: string }) => {
            if (!ack?.received || !ack.messageId) {
              fail('Your ticket was not accepted. Please wait a moment and try again.');
              return;
            }
            const reference = ticketReference(ack.messageId);
            finish(() => resolve({ reference }));
          },
        );
      });
    });
  });
}
