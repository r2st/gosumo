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
import { generateId, ExternalServiceError } from "@gosumo/shared";
import { BaseChannelAdapter } from "./base.adapter";
import { allowUnverifiedWebhook, isProductionEnv } from "../../../common/utils/webhook-verification.util";
import { fetchWithTimeout } from "../../../common/utils/http-timeout.util";

@Injectable()
export class SmsAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.SMS;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  /** Fail-closed switch: an unverifiable webhook is rejected in production. */
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    super("SmsAdapter", { maxAttempts: 3, retryDelayMs: 500 });

    this.accountSid = this.configService.get<string>("twilio.accountSid", "");
    this.authToken = this.configService.get<string>("twilio.authToken", "");
    this.fromNumber = this.configService.get<string>("twilio.fromNumber", "");
    this.isProduction = isProductionEnv(this.configService);

    if (!this.accountSid) {
      this.logger.warn("TWILIO_ACCOUNT_SID is not set — SMS adapter will rely on per-channel credentials");
    }
  }

  validateWebhook(req: RawRequest): boolean {
    if (!this.authToken) {
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        "TWILIO_AUTH_TOKEN is not configured",
      );
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
      // Without the Host header the signed URL cannot be rebuilt, so the
      // signature is uncheckable — same fail-closed rule as a missing token.
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        "Host header missing, cannot reconstruct the signed webhook URL",
      );
    }

    const body = (req.body ?? {}) as Record<string, string>;
    const sortedKeys = Object.keys(body).sort();
    let dataString = webhookUrl;
    for (const key of sortedKeys) {
      dataString += key + (body[key] ?? "");
    }

    const computed = crypto
      .createHmac("sha1", this.authToken)
      .update(dataString)
      .digest("base64");

    // Constant-time compare — a plain `===` leaks how much of the signature
    // matched via early exit, which is enough to forge one byte at a time.
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(computed);
    if (sigBuffer.length !== expectedBuffer.length) {
      this.logger.warn("Webhook rejected: signature length mismatch");
      return false;
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    if (!isValid) {
      this.logger.warn("Webhook rejected: signature mismatch");
    }
    return isValid;
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

      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
          },
          body: formBody,
        },
        { service: "Twilio" },
      );

      if (!response.ok) {
        // Twilio's two message shapes differ, so the flat string is built
        // separately from the taxonomy detail rather than derived from it.
        let errorMessage = "Twilio API returned " + response.status;
        let detail = "API returned " + response.status;
        try {
          const errBody = (await response.json()) as { message?: string };
          if (errBody.message) {
            errorMessage = "Twilio error: " + errBody.message;
            detail = errBody.message;
          }
        } catch {
          // ignore
        }

        const failure = new ExternalServiceError("Twilio", detail, {
          status: response.status,
        });

        // 408/429/5xx are worth another attempt; a bad To number never is.
        if (failure.retryable) {
          throw failure;
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
