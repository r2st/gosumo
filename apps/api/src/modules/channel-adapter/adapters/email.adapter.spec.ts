import { ConfigService } from "@nestjs/config";
import { EmailAdapter } from "./email.adapter";
import { ChannelType, MessageContentType, RawRequest } from "@gosumo/shared";

describe("EmailAdapter", () => {
  let adapter: EmailAdapter;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(""),
    } as unknown as ConfigService;
    adapter = new EmailAdapter(configService);
  });

  it("should have correct channelType", () => {
    expect(adapter.channelType).toBe(ChannelType.EMAIL);
  });

  it("getCapabilities returns EMAIL channelType", () => {
    const caps = adapter.getCapabilities();
    expect(caps.channelType).toBe(ChannelType.EMAIL);
    expect(caps.supportsTemplates).toBe(true);
    expect(caps.supportsInteractiveMessages).toBe(false);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.maxMessageLength).toBe(100000);
  });

  it("validateWebhook always returns true", () => {
    const req: RawRequest = {
      headers: {},
      body: {},
    };
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it("parseInbound parses an email payload", () => {
    const req: RawRequest = {
      headers: {},
      body: {
        from: "customer@example.com",
        to: "support@business.com",
        subject: "Order Inquiry",
        body: "Where is my order?",
        messageId: "msg-123",
      },
    };

    const result = adapter.parseInbound(req);
    expect(result.channel).toBe(ChannelType.EMAIL);
    expect(result.sender.externalId).toBe("customer@example.com");
    expect(result.content.type).toBe(MessageContentType.TEXT);
    if (result.content.type === MessageContentType.TEXT) {
      expect(result.content.text).toContain("Order Inquiry");
      expect(result.content.text).toContain("Where is my order?");
    }
  });

  it("sendMessage returns success when SendGrid accepts the request", async () => {
    // SendGrid returns 202 Accepted with the message id in the x-message-id header
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      status: 202,
      headers: { get: (name: string) => (name === "x-message-id" ? "sg-message-id-123" : null) },
      text: async () => "",
    } as unknown as Response);

    const result = await adapter.sendMessage({
      channelAccountId: "support@business.com",
      recipientExternalId: "customer@example.com",
      content: {
        type: MessageContentType.TEXT,
        text: "Your order is on the way!",
      },
    });

    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe("sg-message-id-123");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/mail/send",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("sendMessage returns a failure result on a 4xx from SendGrid", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
    } as unknown as Response);

    const result = await adapter.sendMessage({
      channelAccountId: "support@business.com",
      recipientExternalId: "customer@example.com",
      content: { type: MessageContentType.TEXT, text: "Hello" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("401");

    fetchSpy.mockRestore();
  });
});
