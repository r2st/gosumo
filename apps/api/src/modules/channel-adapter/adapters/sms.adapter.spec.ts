import { ConfigService } from "@nestjs/config";
import { SmsAdapter } from "./sms.adapter";
import { ChannelType, MessageContentType, RawRequest } from "@gosumo/shared";

describe("SmsAdapter", () => {
  let adapter: SmsAdapter;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(""),
    } as unknown as ConfigService;
    adapter = new SmsAdapter(configService);
  });

  it("should have correct channelType", () => {
    expect(adapter.channelType).toBe(ChannelType.SMS);
  });

  it("getCapabilities returns SMS channelType", () => {
    const caps = adapter.getCapabilities();
    expect(caps.channelType).toBe(ChannelType.SMS);
    expect(caps.supportsTemplates).toBe(false);
    expect(caps.supportsInteractiveMessages).toBe(false);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.maxMessageLength).toBe(1600);
  });

  it("validateWebhook returns true when no auth token is configured", () => {
    const req: RawRequest = {
      headers: {},
      body: {},
    };
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it("parseInbound parses a Twilio SMS payload", () => {
    const req: RawRequest = {
      headers: {},
      body: {
        From: "+14155551234",
        To: "+14155555678",
        Body: "Hello via SMS",
        MessageSid: "SM1234567890",
        NumMedia: "0",
      },
    };

    const result = adapter.parseInbound(req);
    expect(result.channel).toBe(ChannelType.SMS);
    expect(result.sender.externalId).toBe("+14155551234");
    expect(result.content.type).toBe(MessageContentType.TEXT);
    if (result.content.type === MessageContentType.TEXT) {
      expect(result.content.text).toBe("Hello via SMS");
    }
    expect(result.externalId).toBe("SM1234567890");
  });

  it("parseInbound parses an MMS payload with media", () => {
    const req: RawRequest = {
      headers: {},
      body: {
        From: "+14155551234",
        To: "+14155555678",
        Body: "Check this out",
        MessageSid: "MM1234567890",
        NumMedia: "1",
        MediaUrl0: "https://api.twilio.com/media/123",
        MediaContentType0: "image/png",
      },
    };

    const result = adapter.parseInbound(req);
    expect(result.content.type).toBe(MessageContentType.IMAGE);
  });
});
