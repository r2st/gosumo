import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import {
  MAX_TICKET_MESSAGE_CHARS,
  TicketSubmitError,
  formatTicketMessage,
  submitTicket,
  ticketReference,
  ticketWhatsAppText,
  validateTicket,
  type TicketInput,
} from './support-ticket';

const valid: TicketInput = {
  name: 'Asha',
  contact: 'asha@example.com',
  subject: 'Invoice not received',
  description: 'I paid yesterday but did not get the invoice.',
  priority: 'High',
};

type Ack = (resp: unknown) => void;

/** A stand-in socket whose server replies are scripted per event. */
function fakeSocket(replies: Record<string, unknown>, { connect = true } = {}) {
  const handlers: Record<string, () => void> = {};
  const emitted: Array<{ event: string; body: unknown }> = [];
  const socket = {
    on: (event: string, fn: () => void) => {
      handlers[event] = fn;
      if (event === 'connect' && connect) queueMicrotask(fn);
      if (event === 'connect_error' && !connect) queueMicrotask(fn);
      return socket;
    },
    emit: (event: string, body: unknown, ack: Ack) => {
      emitted.push({ event, body });
      queueMicrotask(() => ack(replies[event]));
      return socket;
    },
    disconnect: vi.fn(),
  };
  return { socket: socket as unknown as Socket, emitted, disconnect: socket.disconnect };
}

describe('validateTicket', () => {
  it('accepts a complete ticket with an email or an Indian phone number', () => {
    expect(validateTicket(valid)).toEqual({});
    expect(validateTicket({ ...valid, contact: '+91 98765 43210' })).toEqual({});
  });

  it('flags every missing field', () => {
    const errors = validateTicket({ ...valid, name: ' ', contact: '', subject: '', description: 'short' });
    expect(Object.keys(errors).sort()).toEqual(['contact', 'description', 'name', 'subject']);
  });

  it('rejects contact details that are neither email nor phone', () => {
    expect(validateTicket({ ...valid, contact: 'call me' }).contact).toMatch(/valid email/);
  });
});

describe('formatTicketMessage', () => {
  it('puts subject, priority and sender ahead of the description', () => {
    expect(formatTicketMessage(valid)).toBe(
      'Support ticket: Invoice not received\nPriority: High\nFrom: Asha (asha@example.com)\n\nI paid yesterday but did not get the invoice.',
    );
  });

  it('never exceeds the gateway message ceiling', () => {
    const long = formatTicketMessage({ ...valid, description: 'x'.repeat(10_000) });
    expect(long.length).toBe(MAX_TICKET_MESSAGE_CHARS);
  });
});

describe('ticketReference / ticketWhatsAppText', () => {
  it('derives an 8-char reference from a uuid', () => {
    expect(ticketReference('3f2a9c1e-0000-4000-8000-000000000000')).toBe('3F2A9C1E');
  });

  it('includes the reference and a link back in the WhatsApp text', () => {
    const text = ticketWhatsAppText(valid, 'ABC12345', 'https://desk.doaide.com/support?w=1');
    expect(text).toContain('#ABC12345');
    expect(text).toContain('https://desk.doaide.com/support?w=1');
  });
});

describe('submitTicket', () => {
  it('inits the widget session, sends the ticket and returns a reference', async () => {
    const { socket, emitted, disconnect } = fakeSocket({
      'chat:init': { sessionId: 'signed-token', greeting: 'Hi' },
      'chat:message': { received: true, messageId: 'abcdef12-3456' },
    });
    const factory = vi.fn(() => socket);

    await expect(
      submitTicket({ wsUrl: 'https://api.example.com/', widgetId: 'w-1', input: valid }, factory),
    ).resolves.toEqual({ reference: 'ABCDEF12' });

    expect(factory).toHaveBeenCalledWith('https://api.example.com/webchat');
    expect(emitted[0]).toEqual({ event: 'chat:init', body: { widgetId: 'w-1' } });
    expect(emitted[1].body).toEqual({ sessionId: 'signed-token', text: formatTicketMessage(valid) });
    expect(disconnect).toHaveBeenCalled();
  });

  it('surfaces the gateway greeting when the widget is unknown', async () => {
    const { socket } = fakeSocket({ 'chat:init': { sessionId: '', greeting: 'Widget not found' } });
    await expect(
      submitTicket({ wsUrl: 'https://api.example.com', widgetId: 'nope', input: valid }, () => socket),
    ).rejects.toThrow('Widget not found');
  });

  it('fails when the message is not accepted', async () => {
    const { socket } = fakeSocket({
      'chat:init': { sessionId: 't' },
      'chat:message': { received: false, messageId: 'x' },
    });
    await expect(
      submitTicket({ wsUrl: 'https://api.example.com', widgetId: 'w', input: valid }, () => socket),
    ).rejects.toBeInstanceOf(TicketSubmitError);
  });

  it('fails cleanly when the socket cannot connect', async () => {
    const { socket } = fakeSocket({}, { connect: false });
    await expect(
      submitTicket({ wsUrl: 'https://api.example.com', widgetId: 'w', input: valid }, () => socket),
    ).rejects.toThrow(/could not reach support/);
  });
});
