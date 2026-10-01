import { ConfigService } from "@nestjs/config";
import { InstagramAdapter } from "./instagram.adapter";
import { ChannelType, ExternalServiceError, MessageContentType, RawRequest } from "@gosumo/shared";

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

  // ─────────────────────────────────────────────
  // Payload shapes Meta actually delivers alongside real messages.
  //
  // Instagram batches events, and a batch routinely carries entries the adapter
  // must ignore rather than fail on: echoes of our own sends, read/delivery
  // receipts, and entries with no `messaging` array at all. Getting these wrong
  // is not a parse error — it is the AI replying to itself, or a whole batch
  // being dropped because one member of it was unparseable.
  // ─────────────────────────────────────────────

  /** Wrap messaging events in the envelope Meta posts. */
  const webhook = (
    messaging: unknown[] | undefined,
    object = "instagram",
  ): RawRequest =>
    ({
      headers: {},
      body: {
        object,
        entry: [
          messaging === undefined
            ? { id: "page123", time: 1 }
            : { id: "page123", time: 1, messaging },
        ],
      },
    }) as RawRequest;

  const textEvent = (text: string, mid = "mid.1"): Record<string, unknown> => ({
    sender: { id: "user456" },
    recipient: { id: "page123" },
    timestamp: 1,
    message: { mid, text },
  });

  describe("parseInbound — events that carry no inbound message", () => {
    it("skips an echo of our own outbound message", () => {
      const req = webhook([
        {
          sender: { id: "page123" },
          recipient: { id: "user456" },
          timestamp: 1,
          message: { mid: "mid.echo", text: "our reply", is_echo: true },
        },
        textEvent("the real inbound"),
      ]);

      // Parsing the echo would feed the AI its own words as a customer turn.
      const result = adapter.parseInbound(req);
      expect(result.externalId).toBe("mid.1");
    });

    it("skips a read receipt and parses the message after it", () => {
      const req = webhook([
        {
          sender: { id: "user456" },
          recipient: { id: "page123" },
          timestamp: 1,
          read: { mid: "mid.read" },
        },
        textEvent("after the receipt"),
      ]);

      const result = adapter.parseInbound(req);
      expect(result.content).toMatchObject({ text: "after the receipt" });
    });

    it("throws when an entry has no messaging array at all", () => {
      expect(() => adapter.parseInbound(webhook(undefined))).toThrow(
        /no parseable inbound message/,
      );
    });

    it("throws when every event in the batch is an echo", () => {
      const req = webhook([
        {
          sender: { id: "page123" },
          recipient: { id: "user456" },
          timestamp: 1,
          message: { mid: "mid.echo", text: "ours", is_echo: true },
        },
      ]);

      expect(() => adapter.parseInbound(req)).toThrow(
        /no parseable inbound message/,
      );
    });
  });

  describe("parseInboundAll", () => {
    it("returns every inbound message in a batch", () => {
      const req = webhook([textEvent("first", "mid.a"), textEvent("second", "mid.b")]);

      expect(adapter.parseInboundAll(req).map((m) => m.externalId)).toEqual([
        "mid.a",
        "mid.b",
      ]);
    });

    it("returns an empty array for a non-instagram payload", () => {
      expect(adapter.parseInboundAll(webhook([textEvent("hi")], "page"))).toEqual([]);
    });

    it("drops echoes and receipts but keeps the real messages", () => {
      const req = webhook([
        {
          sender: { id: "page123" },
          recipient: { id: "user456" },
          timestamp: 1,
          message: { mid: "mid.echo", text: "ours", is_echo: true },
        },
        { sender: { id: "user456" }, recipient: { id: "page123" }, timestamp: 1 },
        textEvent("keep me", "mid.keep"),
      ]);

      const result = adapter.parseInboundAll(req);
      expect(result).toHaveLength(1);
      expect(result[0]!.externalId).toBe("mid.keep");
    });

    it("skips an entry with no messaging array without dropping the batch", () => {
      const req = {
        headers: {},
        body: {
          object: "instagram",
          entry: [
            { id: "page123", time: 1 },
            { id: "page123", time: 1, messaging: [textEvent("survivor", "mid.s")] },
          ],
        },
      } as RawRequest;

      // One malformed entry must not cost us the messages in the others.
      expect(adapter.parseInboundAll(req).map((m) => m.externalId)).toEqual([
        "mid.s",
      ]);
    });
  });

  describe("quick replies", () => {
    it("represents a quick-reply tap as interactive content", () => {
      const req = webhook([
        {
          sender: { id: "user456" },
          recipient: { id: "page123" },
          timestamp: 1,
          message: {
            mid: "mid.qr",
            text: "Book a visit",
            quick_reply: { payload: "BOOK_VISIT" },
          },
        },
      ]);

      expect(adapter.parseInbound(req).content).toMatchObject({
        type: MessageContentType.INTERACTIVE,
        interactiveType: "quick_reply",
        payload: { id: "BOOK_VISIT", title: "Book a visit" },
      });
    });

    it("tolerates a quick reply that carries no visible text", () => {
      // Ice-breaker taps arrive with a payload and no `text`; a missing title
      // must not become the string "undefined" in the conversation log.
      const req = webhook([
        {
          sender: { id: "user456" },
          recipient: { id: "page123" },
          timestamp: 1,
          message: { mid: "mid.qr2", quick_reply: { payload: "PRICING" } },
        },
      ]);

      expect(adapter.parseInbound(req).content).toMatchObject({
        payload: { id: "PRICING", title: "" },
      });
    });
  });

  describe("sendMessage — unsupported content", () => {
    it("reports a content type the channel cannot express as a failed send", async () => {
      // The exhaustive-switch guard throws, but `sendWithRetry` converts it to
      // a failed SendResult so the caller's `message.failed` flow runs instead
      // of an exception escaping into the outbound worker.
      const result = await adapter.sendMessage({
        recipientExternalId: "user456",
        content: { type: "HOLOGRAM" },
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cannot send content of type "HOLOGRAM"/);
    });

    it("reports a location send as unsupported rather than throwing", async () => {
      const result = await adapter.sendMessage({
        recipientExternalId: "user456",
        content: { type: MessageContentType.LOCATION, latitude: 1, longitude: 2 },
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/does not support sending location/);
    });
  });

  // ── Media ────────────────────────────────────

  describe("downloadMedia", () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    /** A CDN response whose body streams `chunks` back one at a time. */
    function cdnBody(chunks: number[][], headers: Record<string, string> = {}): unknown {
      let i = 0;
      return {
        ok: true,
        headers: new Headers(headers),
        body: {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: new Uint8Array(chunks[i++]!) }
                : { done: true, value: undefined },
            cancel: async () => undefined,
          }),
        },
      };
    }

    function stub(response: unknown): jest.Mock {
      const fetchMock = jest.fn().mockResolvedValue(response);
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    it("streams the bytes of an image attachment", async () => {
      stub(cdnBody([[1, 2], [3]], { "content-type": "image/jpeg" }));

      const buffer = await adapter.downloadMedia("https://cdn.ig/photo.jpg");

      expect(buffer).toEqual(Buffer.from([1, 2, 3]));
    });

    it("refuses a body over the download ceiling", async () => {
      // The address is whatever `attachment.payload.url` carried, and the
      // whole response would otherwise land in this process's heap.
      stub(
        cdnBody([[1]], {
          "content-type": "video/mp4",
          "content-length": String(512 * 1024 * 1024),
        }),
      );

      await expect(adapter.downloadMedia("https://cdn.ig/huge.mp4")).rejects.toThrow(
        /over the .*-byte limit/,
      );
    });

    it("refuses a body that outgrows the ceiling mid-stream despite an honest-looking header", async () => {
      // No content-length at all: only the running total catches this one.
      const oneMeg = (): number[] => new Array(1024 * 1024).fill(7);
      stub(cdnBody(new Array(30).fill(null).map(oneMeg), { "content-type": "video/mp4" }));

      await expect(adapter.downloadMedia("https://cdn.ig/chunked.mp4")).rejects.toThrow(
        /over the .*-byte limit/,
      );
    });

    it("refuses a plaintext url rather than fetching it", async () => {
      // The URL comes off an inbound webhook, so it names the host this server
      // connects to. http:// puts every internal target in reach.
      const fetchMock = stub(cdnBody([[1]]));

      await expect(adapter.downloadMedia("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
        /must be an https URL/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a non-url media reference rather than fetching it", async () => {
      const fetchMock = stub(cdnBody([[1]]));

      await expect(adapter.downloadMedia("not-a-url")).rejects.toThrow(/must be an https URL/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an html body served in place of an expired attachment", async () => {
      // An expired or swapped CDN URL answers with an error page. Storing that
      // as an image is the stored-XSS shape the message module refuses too.
      stub(cdnBody([[60, 104, 116]], { "content-type": "text/html; charset=utf-8" }));

      await expect(adapter.downloadMedia("https://cdn.ig/expired.jpg")).rejects.toThrow(
        /unexpected content-type text\/html/,
      );
    });

    it("allows a CDN that omits content-type, leaving the size cap as the bound", async () => {
      stub(cdnBody([[9]]));

      await expect(adapter.downloadMedia("https://cdn.ig/x.bin")).resolves.toEqual(
        Buffer.from([9]),
      );
    });

    it("throws when the CDN download fails", async () => {
      stub({ ok: false, status: 410, statusText: "Gone" });

      const error = await adapter.downloadMedia("https://cdn.ig/gone.jpg").then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).message).toBe("download failed");
    });
  });
});
