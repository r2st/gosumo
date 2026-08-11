/**
 * WebChatAdapter — content-type rendering and the convert-to-text send paths.
 *
 * Web chat has no native template or interactive rendering, so `sendTemplate`
 * and `sendInteractive` flatten to plain text and re-enter `sendMessage`. The
 * flattening is what the widget actually displays, so each shape is pinned
 * here, along with the non-TEXT branches of `sendMessage` itself.
 */

import { ConfigService } from '@nestjs/config';
import { MessageContentType } from '@gosumo/shared';
import { WebChatAdapter, webchatResponseMap } from './webchat.adapter';

const SESSION_ID = 'session-branches-1';
const WIDGET_ID = 'widget-branches-1';

function lastTextFor(sessionId: string): string | undefined {
  const pending = webchatResponseMap.get(sessionId);
  return pending?.[pending.length - 1]?.text;
}

describe('WebChatAdapter — content branches', () => {
  let adapter: WebChatAdapter;

  beforeEach(() => {
    webchatResponseMap.clear();
    const configService = {
      get: jest.fn().mockReturnValue(''),
    } as unknown as ConfigService;
    adapter = new WebChatAdapter(configService);
  });

  afterEach(() => {
    webchatResponseMap.clear();
  });

  describe('sendMessage', () => {
    it('renders an image with its caption when one is present', async () => {
      const result = await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: {
          type: MessageContentType.IMAGE,
          url: 'https://cdn.example.com/kurta.jpg',
          mimeType: 'image/jpeg',
          caption: 'Our new kurta',
        },
      });

      expect(result.success).toBe(true);
      expect(lastTextFor(SESSION_ID)).toBe('Our new kurta');
    });

    it('falls back to the URL when an image has no caption', async () => {
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: {
          type: MessageContentType.IMAGE,
          url: 'https://cdn.example.com/kurta.jpg',
          mimeType: 'image/jpeg',
        },
      });

      expect(lastTextFor(SESSION_ID)).toBe(
        '[Image: https://cdn.example.com/kurta.jpg]',
      );
    });

    it('renders a document by filename', async () => {
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: {
          type: MessageContentType.DOCUMENT,
          url: 'https://cdn.example.com/invoice.pdf',
          filename: 'invoice.pdf',
          mimeType: 'application/pdf',
        },
      });

      expect(lastTextFor(SESSION_ID)).toBe('[Document: invoice.pdf]');
    });

    it('degrades to a placeholder for a content type the widget cannot render', async () => {
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: {
          type: MessageContentType.LOCATION,
          latitude: 19.076,
          longitude: 72.8777,
        },
      });

      expect(lastTextFor(SESSION_ID)).toBe('[Unsupported content type]');
    });

    it('appends to an existing session queue instead of replacing it', async () => {
      const send = (text: string) =>
        adapter.sendMessage({
          channelAccountId: WIDGET_ID,
          recipientExternalId: SESSION_ID,
          content: { type: MessageContentType.TEXT, text },
        });

      await send('first');
      await send('second');

      const pending = webchatResponseMap.get(SESSION_ID);
      expect(pending).toHaveLength(2);
      expect(pending?.map((m) => m.text)).toEqual(['first', 'second']);
    });

    it('keeps separate queues per session', async () => {
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        content: { type: MessageContentType.TEXT, text: 'for A' },
      });
      await adapter.sendMessage({
        channelAccountId: WIDGET_ID,
        recipientExternalId: 'session-branches-2',
        content: { type: MessageContentType.TEXT, text: 'for B' },
      });

      expect(lastTextFor(SESSION_ID)).toBe('for A');
      expect(lastTextFor('session-branches-2')).toBe('for B');
    });
  });

  describe('sendTemplate', () => {
    it('flattens the template name and parameters into text', async () => {
      const result = await adapter.sendTemplate({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        templateName: 'order_shipped',
        language: 'en',
        parameters: { name: 'Priya', orderNumber: 'ORD-2026-00042' },
      });

      expect(result.success).toBe(true);
      expect(lastTextFor(SESSION_ID)).toBe(
        'Template: order_shipped — Priya, ORD-2026-00042',
      );
    });

    it('renders a parameterless template without a trailing separator', async () => {
      await adapter.sendTemplate({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        templateName: 'welcome',
        language: 'en',
        parameters: {},
      });

      expect(lastTextFor(SESSION_ID)).toBe('Template: welcome — ');
    });
  });

  describe('sendInteractive', () => {
    it('appends the footer on its own line when present', async () => {
      const result = await adapter.sendInteractive({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        body: 'Pick a size',
        footer: 'Free returns within 7 days',
        interactiveType: 'button',
        action: { buttons: [{ id: 'S', title: 'Small' }] },
      });

      expect(result.success).toBe(true);
      expect(lastTextFor(SESSION_ID)).toBe(
        'Pick a size\nFree returns within 7 days',
      );
    });

    it('sends the body alone when there is no footer', async () => {
      await adapter.sendInteractive({
        channelAccountId: WIDGET_ID,
        recipientExternalId: SESSION_ID,
        body: 'Pick a size',
        interactiveType: 'button',
        action: { buttons: [{ id: 'S', title: 'Small' }] },
      });

      expect(lastTextFor(SESSION_ID)).toBe('Pick a size');
    });
  });

  describe('parseInbound — defaults', () => {
    it('fills in a generated session id and empty widget/text for a bare body', () => {
      const message = adapter.parseInbound({ headers: {}, body: {} });

      expect(message.sender.externalId).toEqual(expect.any(String));
      expect(message.sender.externalId).not.toHaveLength(0);
      expect(message.sender.displayName).toBe('Website Visitor');
      expect(message.channelAccountId).toBe('');
      expect(message.content).toEqual({
        type: MessageContentType.TEXT,
        text: '',
      });
      expect(message.timestamp).toBeInstanceOf(Date);
    });

    it('keeps a supplied sender name and timestamp', () => {
      const message = adapter.parseInbound({
        headers: {},
        body: {
          widgetId: WIDGET_ID,
          sessionId: SESSION_ID,
          text: 'Hi',
          sender: 'Priya',
          timestamp: '2026-06-27T10:00:00Z',
        },
      });

      expect(message.sender.displayName).toBe('Priya');
      expect(message.timestamp.toISOString()).toBe('2026-06-27T10:00:00.000Z');
      expect(message.metadata).toMatchObject({
        widgetId: WIDGET_ID,
        sessionId: SESSION_ID,
      });
    });
  });
});
