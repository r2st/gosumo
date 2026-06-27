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

  constructor(private readonly configService: ConfigService) {
    super("EmailAdapter");
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
   * Send an email. Placeholder implementation — logs the intent.
   * Actual SMTP/Gmail integration requires additional setup.
   */
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const fromEmail = this.configService.get<string>("email.fromEmail", "");

    let text: string;
    if (message.content.type === MessageContentType.TEXT) {
      text = message.content.text;
    } else {
      text = "[Content type " + message.content.type + " — see attachment]";
    }

    this.logger.log(
      "Email send requested: from=" + fromEmail +
      " to=" + message.recipientExternalId +
      " body length=" + text.length,
    );

    // TODO: Implement actual SMTP sending via nodemailer
    // const smtpConfig = this.configService.get('email.smtp');
    // if (smtpConfig) { ... send via nodemailer ... }

    const messageId = generateId();
    return {
      success: true,
      externalMessageId: messageId,
      sentAt: new Date(),
    };
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
