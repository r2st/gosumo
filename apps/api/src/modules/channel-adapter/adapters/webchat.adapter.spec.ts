import { ConfigService } from "@nestjs/config";
import { WebChatAdapter } from "./webchat.adapter";
import { ChannelType, MessageContentType, RawRequest } from "@gosumo/shared";

describe("WebChatAdapter", () => {
  let adapter: WebChatAdapter;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(""),
    } as unknown as ConfigService;
    adapter = new WebChatAdapter(configService);
  });

  it("should have correct channelType", () => {
    expect(adapter.channelType).toBe(ChannelType.WEB_CHAT);
  });

  it("getCapabilities returns WEB_CHAT channelType", () => {
    const caps = adapter.getCapabilities();
    expect(caps.channelType).toBe(ChannelType.WEB_CHAT);
    expect(caps.supportsTemplates).toBe(false);
    expect(caps.supportsInteractiveMessages).toBe(true);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.maxMessageLength).toBe(10000);
  });

  it("validateWebhook accepts an unsigned call outside production when no secret is set", () => {
    // The WebSocket gateway never calls this; the HTTP path through
    // `POST /webhooks/web_chat` does, and its production behaviour is pinned in
    // `common/utils/webhook-verification.spec.ts`.
    const req: RawRequest = {
      headers: {},
      body: {},
    };
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it("parseInbound parses a webchat message", () => {
    const req: RawRequest = {
      headers: {},
      body: {
        widgetId: "widget-123",
        sessionId: "session-456",
        text: "Hello from web chat",
        timestamp: Date.now(),
      },
    };

    const result = adapter.parseInbound(req);
    expect(result.channel).toBe(ChannelType.WEB_CHAT);
    expect(result.sender.externalId).toBe("session-456");
    expect(result.content.type).toBe(MessageContentType.TEXT);
    if (result.content.type === MessageContentType.TEXT) {
      expect(result.content.text).toBe("Hello from web chat");
    }
  });

  it("sendMessage stores message in response map", async () => {
    const result = await adapter.sendMessage({
      channelAccountId: "widget-123",
      recipientExternalId: "session-456",
      content: {
        type: MessageContentType.TEXT,
        text: "Reply from bot",
      },
    });

    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBeDefined();
  });
});
