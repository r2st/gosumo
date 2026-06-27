import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
export class EmailAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.EMAIL;

  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly fromName: string;

  constructor(private readonly configService: ConfigService) {
    super("EmailAdapter");
    this.apiKey = this.configService.get<string>("sendgrid.apiKey", "");
    this.fromEmail = this.configService.get<string>("sendgrid.fromEmail", "");
    this.fromName = this.configService.get<string>("sendgrid.fromName", "GoSumo");
  }

  /** Email comes via polling/push, not external webhook — always valid. */
  validateWebhook(_req: RawRequest): boolean {
    return true;
  }

  /**
   * Parse inbound email format.
   * Expected body: { from, to, subject, body, messageId, html?, attachments? }
   */
  parseInbound(req: RawRequest): NormalizedMessage {
    const body = req.body as {
      from?: string;
      to?: string;
      subject?: string;
      body?: string;
      html?: string;
      messageId?: string;
      attachments?: Array<{ filename: string; url: string; mimeType: string }>;
    };

    const from = body.from || "";
    const to = body.to || "";
    const subject = body.subject || "";
    const emailBody = body.body || body.html || "";
    const messageId = body.messageId || generateId();

    // Combine subject and body
    const fullText = subject ? "Subject: " + subject + "\n\n" + emailBody : emailBody;

    return {
      id: generateId(),
      externalId: messageId,
      channel: ChannelType.EMAIL,
      channelAccountId: to,
      direction: MessageDirection.INBOUND,
      sender: {
        externalId: from,
        displayName: from,
      },
      content: {
        type: MessageContentType.TEXT,
        text: fullText,
      },
      timestamp: new Date(),
      metadata: {
        from,
        to,
        subject,
        messageId,
        hasAttachments: !!(body.attachments && body.attachments.length > 0),
      },
    };
  }

  /**
   * Send an email via SendGrid API v3.
   */
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      let textContent: string;
      if (message.content.type === MessageContentType.TEXT) {
        textContent = message.content.text;
      } else {
        textContent = "[Content type " + message.content.type + " — see attachment]";
      }

      // Build plain text and simple HTML version
      const htmlContent = textContent.replace(/\n/g, "<br>");

      const payload = {
        personalizations: [
          {
            to: [{ email: message.recipientExternalId }],
          },
        ],
        from: {
          email: this.fromEmail,
          name: this.fromName,
        },
        subject: (message as any).subject || "Message from GoSumo",
        content: [
          { type: "text/plain", value: textContent },
          { type: "text/html", value: htmlContent },
        ],
      };

      this.logger.log(
        "Sending email via SendGrid: to=" + message.recipientExternalId +
        " from=" + this.fromEmail +
        " body length=" + textContent.length,
      );

      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      // 4xx = non-retryable business error
      if (response.status >= 400 && response.status < 500) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = "Unknown client error";
        }
        this.logger.warn(
          "SendGrid returned " + response.status + ": " + errorBody,
        );
        return {
          success: false,
          error: "SendGrid " + response.status + ": " + errorBody,
        };
      }

      // 5xx = transient, throw so sendWithRetry retries
      if (response.status >= 500) {
        let errorBody: string;
        try {
          errorBody = await response.text();
        } catch {
          errorBody = "Server error";
        }
        throw new Error("SendGrid " + response.status + ": " + errorBody);
      }

      // Success (202 Accepted is the normal success code for SendGrid)
      const externalMessageId =
        response.headers.get("x-message-id") || generateId();

      this.logger.log(
        "Email sent successfully via SendGrid, x-message-id=" + externalMessageId,
      );

      return {
        success: true,
        externalMessageId,
        sentAt: new Date(),
      };
    }, "sendMessage");
  }

  /** Convert template to email body and send. */
  async sendTemplate(template: TemplateMessage): Promise<SendResult> {
    const paramEntries = Object.entries(template.parameters)
      .map(function(entry) { return entry[0] + ": " + entry[1]; })
      .join("\n");

    const text = "Template: " + template.templateName + "\n\n" + paramEntries;

    return this.sendMessage({
      channelAccountId: template.channelAccountId,
      recipientExternalId: template.recipientExternalId,
      content: { type: MessageContentType.TEXT, text },
      correlationId: template.correlationId,
    });
  }

  async sendInteractive(_interactive: InteractiveMessage): Promise<SendResult> {
    return {
      success: false,
      error: "Email does not support interactive messages",
    };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.EMAIL,
      supportsTemplates: true,
      supportsInteractiveMessages: false,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: false,
      supportsReadReceipts: false,
      supportsPaymentLinks: false,
      maxMessageLength: 100000,
    };
  }
}
