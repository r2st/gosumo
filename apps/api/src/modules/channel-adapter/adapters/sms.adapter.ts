import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  ChannelCapabilities,
  NormalizedMessage,
  OutboundMessage,
  SendResult,
  TemplateMessage,
  InteractiveMessage,
  RawRequest,
} from "@gosumo/shared";
import { generateId } from "@gosumo/shared";
import { BaseChannelAdapter } from "./base.adapter";

@Injectable()
export class SmsAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.SMS;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;

  constructor(private readonly configService: ConfigService) {
    super("SmsAdapter", { maxAttempts: 3, retryDelayMs: 500 });

    this.accountSid = this.configService.get<string>("twilio.accountSid", "");
    this.authToken = this.configService.get<string>("twilio.authToken", "");
    this.fromNumber = this.configService.get<string>("twilio.fromNumber", "");

    if (!this.accountSid) {
      this.logger.warn("TWILIO_ACCOUNT_SID is not set — SMS adapter will rely on per-channel credentials");
    }
  }

  validateWebhook(req: RawRequest): boolean {
    if (!this.authToken) {
      this.logger.warn("Webhook signature verification skipped — no auth token configured");
      return true;
    }

    const signature = req.headers["x-twilio-signature"] ?? "";
    if (!signature) {
      this.logger.warn("Webhook rejected: missing X-Twilio-Signature header");
      return false;
    }

    // Reconstruct the data string: URL + sorted body params
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"] || "";
    const originalUrl = req.headers["x-original-url"] || "";
    const webhookUrl = proto + "://" + host + originalUrl;

    if (!host) {
      this.logger.warn("Cannot reconstruct webhook URL for Twilio signature validation — skipping");
      return true;
    }

    const body = req.body as Record<string, string>;
    const sortedKeys = Object.keys(body).sort();
    let dataString = webhookUrl;
    for (const key of sortedKeys) {
      dataString += key + (body[key] ?? "");
    }

    const computed = crypto
      .createHmac("sha1", this.authToken)
      .update(dataString)
      .digest("base64");

    return signature === computed;
  }

  parseInbound(req: RawRequest): NormalizedMessage {
    const body = req.body as Record<string, string>;

    const from = body.From || body.from || "";
    const to = body.To || body.to || "";
    const text = body.Body || body.body || "";
    const messageSid = body.MessageSid || body.messageSid || generateId();
    const numMedia = parseInt(body.NumMedia || body.numMedia || "0", 10);

    if (numMedia > 0 && body.MediaUrl0) {
      return {
        id: generateId(),
        externalId: messageSid,
        channel: ChannelType.SMS,
        channelAccountId: to,
        direction: MessageDirection.INBOUND,
        sender: { externalId: from },
        content: {
          type: MessageContentType.IMAGE,
          url: body.MediaUrl0,
          caption: text || undefined,
          mimeType: body.MediaContentType0 || "image/jpeg",
        },
        timestamp: new Date(),
        metadata: { from, to, numMedia, messageSid },
      };
    }

    return {
      id: generateId(),
      externalId: messageSid,
      channel: ChannelType.SMS,
      channelAccountId: to,
      direction: MessageDirection.INBOUND,
      sender: { externalId: from },
      content: {
        type: MessageContentType.TEXT,
        text,
      },
      timestamp: new Date(),
      metadata: { from, to, messageSid },
    };
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const sid = this.accountSid;
      const token = this.authToken;
      const from = this.fromNumber || message.channelAccountId;

      if (!sid || !token) {
        return {
          success: false,
          error: "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
        };
      }

      const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";

      const params: Record<string, string> = {
        From: from,
        To: message.recipientExternalId,
      };

      if (message.content.type === MessageContentType.TEXT) {
        params.Body = message.content.text;
      } else if (message.content.type === MessageContentType.IMAGE) {
        params.Body = message.content.caption || "";
        params.MediaUrl = message.content.url;
      } else {
        params.Body = "[content type not supported via SMS]";
      }

      const formBody = new URLSearchParams(params).toString();

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
        },
        body: formBody,
      });

      if (!response.ok) {
        let errorMessage = "Twilio API returned " + response.status;
        try {
          const errBody = (await response.json()) as { message?: string };
          if (errBody.message) {
            errorMessage = "Twilio error: " + errBody.message;
          }
        } catch {
          // ignore
        }

        if (response.status >= 500) {
          throw new Error(errorMessage);
        }
        return { success: false, error: errorMessage };
      }

      const json = (await response.json()) as { sid?: string };
      return {
        success: true,
        externalMessageId: json.sid,
        sentAt: new Date(),
      };
    }, "sendMessage");
  }

  async sendTemplate(_template: TemplateMessage): Promise<SendResult> {
    return { success: false, error: "SMS does not support template messages" };
  }

  async sendInteractive(_interactive: InteractiveMessage): Promise<SendResult> {
    return { success: false, error: "SMS does not support interactive messages" };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.SMS,
      supportsTemplates: false,
      supportsInteractiveMessages: false,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: false,
      supportsReadReceipts: false,
      supportsPaymentLinks: false,
      maxMessageLength: 1600,
    };
  }
}
