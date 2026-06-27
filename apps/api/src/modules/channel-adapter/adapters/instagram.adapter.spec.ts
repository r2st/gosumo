import { ConfigService } from "@nestjs/config";
import { InstagramAdapter } from "./instagram.adapter";
import { ChannelType, MessageContentType, RawRequest } from "@gosumo/shared";

describe("InstagramAdapter", () => {
  let adapter: InstagramAdapter;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(""),
    } as unknown as ConfigService;
    adapter = new InstagramAdapter(configService);
  });

  it("should have correct channelType", () => {
    expect(adapter.channelType).toBe(ChannelType.INSTAGRAM);
  });

  it("getCapabilities returns INSTAGRAM channelType", () => {
    const caps = adapter.getCapabilities();
    expect(caps.channelType).toBe(ChannelType.INSTAGRAM);
    expect(caps.supportsTemplates).toBe(false);
    expect(caps.supportsMedia).toBe(true);
    expect(caps.maxMessageLength).toBe(1000);
  });

  it("validateWebhook returns true when no appSecret is configured", () => {
    const req: RawRequest = {
      headers: {},
      body: {},
    };
    expect(adapter.validateWebhook(req)).toBe(true);
  });

  it("parseInbound parses a text message", () => {
    const req: RawRequest = {
      headers: {},
      body: {
        object: "instagram",
        entry: [
          {
            id: "page123",
            time: Date.now(),
            messaging: [
              {
                sender: { id: "user456" },
                recipient: { id: "page123" },
                timestamp: Date.now(),
                message: {
                  mid: "mid.123",
                  text: "Hello from Instagram",
                },
              },
            ],
          },
        ],
      },
    };

    const result = adapter.parseInbound(req);
    expect(result.channel).toBe(ChannelType.INSTAGRAM);
    expect(result.sender.externalId).toBe("user456");
    expect(result.content.type).toBe(MessageContentType.TEXT);
    if (result.content.type === MessageContentType.TEXT) {
      expect(result.content.text).toBe("Hello from Instagram");
    }
  });
});
