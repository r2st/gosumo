import { Response } from 'express';
import { WebChatWidgetController } from './webchat-widget';

/**
 * The widget is a JavaScript bundle assembled from a string array, so nothing
 * type-checks it — a stray quote ships a broken embed to every customer site.
 * These tests parse the emitted source and pin the contract the embed snippet
 * relies on (the data-* attributes and the websocket URL derivation).
 */
describe('WebChatWidgetController', () => {
  let controller: WebChatWidgetController;
  let res: { setHeader: jest.Mock; send: jest.Mock };

  const servedScript = (): string => {
    controller.serveWidget(res as unknown as Response);
    return res.send.mock.calls[0][0] as string;
  };

  beforeEach(() => {
    controller = new WebChatWidgetController();
    res = { setHeader: jest.fn(), send: jest.fn() };
  });

  describe('response headers', () => {
    it('serves the bundle as JavaScript', () => {
      controller.serveWidget(res as unknown as Response);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/javascript',
      );
    });

    it('allows shared caching for an hour', () => {
      controller.serveWidget(res as unknown as Response);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=3600',
      );
    });

    it('sets both headers before sending the body', () => {
      const order: string[] = [];
      res.setHeader.mockImplementation((name: string) => order.push(name));
      res.send.mockImplementation(() => order.push('send'));
      controller.serveWidget(res as unknown as Response);
      expect(order).toEqual(['Content-Type', 'Cache-Control', 'send']);
    });
  });

  describe('emitted bundle', () => {
    it('is syntactically valid JavaScript', () => {
      const js = servedScript();
      expect(() => new Function(js)).not.toThrow();
    });

    it('is wrapped in an IIFE so it leaks no globals into the host page', () => {
      const js = servedScript().trim();
      expect(js.startsWith('(function() {')).toBe(true);
      expect(js.endsWith('})();')).toBe(true);
    });

    it('reads its configuration from the embed script’s data attributes', () => {
      const js = servedScript();
      for (const attribute of [
        'data-widget-id',
        'data-business-id',
        'data-primary-color',
      ]) {
        expect(js).toContain(`getAttribute('${attribute}')`);
      }
    });

    it('falls back to the brand indigo when no primary colour is supplied', () => {
      expect(servedScript()).toContain(
        "script.getAttribute('data-primary-color') || '#6366f1'",
      );
    });

    it('derives the websocket URL from the script origin, not a hardcoded host', () => {
      const js = servedScript();
      expect(js).toContain('script.src.replace(');
      expect(js).toContain("host.replace(/^http/, 'ws') + '/webchat'");
      expect(js).not.toContain('localhost');
    });

    it('speaks the chat:init / chat:message / chat:response protocol', () => {
      const js = servedScript();
      expect(js).toContain("socket.emit('chat:init'");
      expect(js).toContain("socket.emit('chat:message'");
      expect(js).toContain("socket.on('chat:response'");
    });

    it('renders customer text via textContent, never innerHTML', () => {
      const js = servedScript();
      // addMessage is the only place untrusted text reaches the DOM.
      expect(js).toContain('msg.textContent = text;');
      expect(js).not.toContain('msg.innerHTML');
    });

    it('refuses to send an empty message or one with no live session', () => {
      expect(servedScript()).toContain(
        'if (!text || !socket || !sessionId) return;',
      );
    });

    it('connects lazily — only when the panel is first opened', () => {
      expect(servedScript()).toContain('if (isOpen && !socket) connect();');
    });

    it('produces byte-identical output across requests, so the hour-long cache is safe', () => {
      const first = servedScript();
      res.send.mockClear();
      const second = servedScript();
      expect(second).toBe(first);
    });
  });
});
