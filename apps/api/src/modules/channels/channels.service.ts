import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChannelType } from "@gosumo/shared";
import { generateId } from "@gosumo/shared";
import { PrismaService } from "../../common/services/prisma.service";
import {
  encryptJson,
  decryptJson,
  maskCredentialFields,
} from "../../common/utils/encryption.util";
import { ConnectChannelDto } from "./dto";

interface ChannelResponse {
  id: string;
  businessId: string;
  type: ChannelType;
  displayName: string;
  status: "CONNECTED" | "PENDING" | "DISCONNECTED";
  accountId: string;
  webhookUrl: string | null;
  metadata: Record<string, unknown>;
  connectedAt: string;
  lastMessageAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  credentials: Record<string, { set: boolean; last4?: string; value?: string }>;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async listChannels(businessId: string) {
    const rows = await this.prisma.channel_accounts.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { created_at: "desc" },
    });

    const data = rows.map((r) => this.toChannelResponse(r));
    return { data, total: data.length, hasMore: false, cursor: null };
  }

  async connectChannel(
    businessId: string,
    channelType: ChannelType,
    body: ConnectChannelDto,
  ) {
    const creds = this.buildCredentials(channelType, body);
    const encrypted = encryptJson(creds);
    const externalId = this.resolveExternalId(channelType, body);
    const displayName = body.displayName || `${channelType} Channel`;

    const apiBase =
      this.configService.get<string>("app.apiBaseUrl") ||
      this.configService.get<string>("API_BASE_URL") ||
      "https://api.gosumo.ai";

    const webhookUrl = `${apiBase}/v1/webhooks/${channelType.toLowerCase()}`;
    const capabilities = this.defaultCapabilities(channelType);
    const metadata: Record<string, unknown> = {};

    if (channelType === ChannelType.WEB_CHAT && body.widgetConfig) {
      metadata.widgetConfig = body.widgetConfig;
    }
    if (body.title) metadata.title = body.title;
    if (body.primaryColor) metadata.primaryColor = body.primaryColor;

    const existing = await this.prisma.channel_accounts.findFirst({
      where: {
        business_id: businessId,
        channel: channelType,
        external_id: externalId,
        deleted_at: null,
      },
    });

    let record;
    if (existing) {
      record = await this.prisma.channel_accounts.update({
        where: { id: existing.id, business_id: businessId },
        data: {
          name: displayName,
          credentials: encrypted,
          webhook_url: webhookUrl,
          is_active: true,
          capabilities: capabilities as any,
          metadata: metadata as any,
          external_account: body.wabaId || body.pageId || null,
          deleted_at: null,
        },
      });
      this.logger.log(`Updated channel account ${record.id} for ${channelType}`);
    } else {
      record = await this.prisma.channel_accounts.create({
        data: {
          business_id: businessId,
          channel: channelType,
          name: displayName,
          external_id: externalId,
          external_account: body.wabaId || body.pageId || null,
          credentials: encrypted,
          webhook_url: webhookUrl,
          is_active: true,
          is_verified: false,
          capabilities: capabilities as any,
          metadata: metadata as any,
        },
      });
      this.logger.log(`Created channel account ${record.id} for ${channelType}`);
    }

    return this.toChannelResponse(record);
  }

  async disconnectChannel(businessId: string, channelId: string) {
    const record = await this.prisma.channel_accounts.findFirst({
      where: { id: channelId, business_id: businessId, deleted_at: null },
    });

    if (!record) {
      throw new NotFoundException(`Channel ${channelId} not found`);
    }

    await this.prisma.channel_accounts.update({
      where: { id: channelId, business_id: businessId },
      data: { deleted_at: new Date(), is_active: false },
    });

    return { success: true, message: "Channel disconnected" };
  }

  async testConnection(businessId: string, channelId: string) {
    const record = await this.prisma.channel_accounts.findFirst({
      where: { id: channelId, business_id: businessId, deleted_at: null },
    });

    if (!record) {
      throw new NotFoundException(`Channel ${channelId} not found`);
    }

    const creds = decryptJson(record.credentials as string);
    const startMs = Date.now();

    try {
      switch (record.channel) {
        case ChannelType.WHATSAPP: {
          const phoneNumberId = creds.phoneNumberId || record.external_id;
          const token = creds.accessToken as string;
          const resp = await fetch(
            `https://graph.facebook.com/v19.0/${phoneNumberId}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!resp.ok) {
            const errBody = await resp.text();
            return {
              success: false,
              message: `WhatsApp API error ${resp.status}: ${errBody}`,
              latencyMs: Date.now() - startMs,
            };
          }
          return { success: true, message: "WhatsApp connection verified", latencyMs: Date.now() - startMs };
        }

        case ChannelType.INSTAGRAM: {
          const pageId = creds.pageId || record.external_id;
          const token = creds.accessToken as string;
          const resp = await fetch(
            `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!resp.ok) {
            const errBody = await resp.text();
            return {
              success: false,
              message: `Instagram API error ${resp.status}: ${errBody}`,
              latencyMs: Date.now() - startMs,
            };
          }
          return { success: true, message: "Instagram connection verified", latencyMs: Date.now() - startMs };
        }

        case ChannelType.SMS: {
          const sid = creds.accountSid as string;
          const authTkn = creds.authToken as string;
          const resp = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
            {
              headers: {
                Authorization: "Basic " + Buffer.from(`${sid}:${authTkn}`).toString("base64"),
              },
            },
          );
          if (!resp.ok) {
            const errBody = await resp.text();
            return {
              success: false,
              message: `Twilio API error ${resp.status}: ${errBody}`,
              latencyMs: Date.now() - startMs,
            };
          }
          return { success: true, message: "Twilio SMS connection verified", latencyMs: Date.now() - startMs };
        }

        case ChannelType.WEB_CHAT:
          return { success: true, message: "Web Chat is self-contained", latencyMs: Date.now() - startMs };

        case ChannelType.EMAIL: {
          const fromEmail = creds.fromEmail || record.external_id;
          if (!fromEmail) {
            return { success: false, message: "No fromEmail configured", latencyMs: Date.now() - startMs };
          }
          return { success: true, message: `Email configured for ${fromEmail}`, latencyMs: Date.now() - startMs };
        }

        default:
          return { success: false, message: `Unknown channel type: ${record.channel}`, latencyMs: Date.now() - startMs };
      }
    } catch (err) {
      return {
        success: false,
        message: `Connection test failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - startMs,
      };
    }
  }

  /**
   * Widget bootstrap for the embeddable web-chat script.
   *
   * Reachable unauthenticated, so `businessId` may be empty and the lookup then
   * falls back to the widget id alone. That is safe only because the response
   * carries no secrets — the widget id, the owning business id, and the public
   * widget config, all of which are already in the page that embeds it. Do not
   * add credential or conversation data to this shape.
   */
  async getWebChatEmbed(businessId: string, channelId: string) {
    // When called from a @Public() endpoint, businessId may be empty.
    // Look up by channelId directly, optionally filtering by businessId.
    const whereClause: Record<string, unknown> = {
      id: channelId,
      channel: ChannelType.WEB_CHAT,
      deleted_at: null,
    };
    if (businessId) {
      whereClause.business_id = businessId;
    }

    const record = await this.prisma.channel_accounts.findFirst({
      where: whereClause,
    });

    if (!record) {
      throw new NotFoundException(`WebChat channel ${channelId} not found`);
    }

    const meta = record.metadata as Record<string, unknown>;
    const apiBase =
      this.configService.get<string>("app.apiBaseUrl") ||
      this.configService.get<string>("API_BASE_URL") ||
      "https://api.gosumo.ai";

    return {
      widgetId: record.id,
      businessId: record.business_id,
      config: meta.widgetConfig || {},
      snippet: `<script src="${apiBase}/v1/webchat/widget.js" data-widget-id="${record.id}" data-business-id="${record.business_id}" async></script>`,
    };
  }

  /**
   * Decrypt a channel's provider credentials.
   *
   * This returns live secrets — access tokens, app secrets, Twilio auth tokens —
   * so it takes the tenant explicitly and filters on it. Resolving by bare id
   * would let any caller holding a channel id read another business's provider
   * credentials in plaintext.
   */
  async getChannelCredentials(
    businessId: string,
    channelAccountId: string,
  ): Promise<Record<string, unknown>> {
    const record = await this.prisma.channel_accounts.findFirst({
      where: { id: channelAccountId, business_id: businessId, deleted_at: null },
    });

    if (!record) {
      throw new NotFoundException(`Channel account ${channelAccountId} not found`);
    }

    return decryptJson(record.credentials as string);
  }

  /**
   * Resolve the channel account an inbound webhook belongs to.
   *
   * Deliberately cross-tenant: the provider posts a channel type and its own
   * external id and nothing else, so there is no tenant to scope by — the row
   * this returns is what establishes one. Everything downstream uses the
   * `business_id` read back from it.
   */
  async findByExternalId(channel: ChannelType, externalId: string) {
    return this.prisma.channel_accounts.findFirst({
      where: {
        channel,
        external_id: externalId,
        is_active: true,
        deleted_at: null,
      },
    });
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private toChannelResponse(row: Record<string, unknown>): ChannelResponse {
    const creds = (() => {
      try {
        return decryptJson(row.credentials as string);
      } catch {
        return {};
      }
    })();

    const deletedAt = row.deleted_at as Date | null;
    const isActive = row.is_active as boolean;
    const isVerified = row.is_verified as boolean;

    let status: "CONNECTED" | "PENDING" | "DISCONNECTED";
    if (deletedAt) {
      status = "DISCONNECTED";
    } else if (isActive && isVerified) {
      status = "CONNECTED";
    } else if (isActive && !isVerified) {
      status = "PENDING";
    } else {
      status = "DISCONNECTED";
    }

    return {
      id: row.id as string,
      businessId: row.business_id as string,
      type: row.channel as ChannelType,
      displayName: row.name as string,
      status,
      accountId: row.external_id as string,
      webhookUrl: (row.webhook_url as string) || null,
      metadata: (row.metadata as Record<string, unknown>) || {},
      connectedAt: (row.created_at as Date)?.toISOString?.() || "",
      lastMessageAt: null,
      errorMessage: null,
      createdAt: (row.created_at as Date)?.toISOString?.() || "",
      updatedAt: (row.updated_at as Date)?.toISOString?.() || "",
      credentials: maskCredentialFields(creds),
    };
  }

  private buildCredentials(channelType: ChannelType, body: ConnectChannelDto): Record<string, unknown> {
    if (body.credentials && Object.keys(body.credentials).length > 0) {
      return body.credentials;
    }

    switch (channelType) {
      case ChannelType.WHATSAPP:
        return { phoneNumberId: body.phoneNumberId, wabaId: body.wabaId, accessToken: body.accessToken, appSecret: body.appSecret };
      case ChannelType.INSTAGRAM:
        return { pageId: body.pageId, accessToken: body.accessToken, appSecret: body.appSecret };
      case ChannelType.SMS:
        return { provider: body.provider || "twilio", accountSid: body.accountSid, authToken: body.authToken, phoneNumber: body.phoneNumber, apiKey: body.apiKey };
      case ChannelType.WEB_CHAT:
        return { title: body.title || "Chat with us", primaryColor: body.primaryColor || "#6366f1" };
      case ChannelType.EMAIL:
        return { fromEmail: body.fromEmail, fromName: body.fromName, smtp: body.smtp };
      default:
        return {};
    }
  }

  private resolveExternalId(channelType: ChannelType, body: ConnectChannelDto): string {
    switch (channelType) {
      case ChannelType.WHATSAPP: return body.phoneNumberId || generateId();
      case ChannelType.INSTAGRAM: return body.pageId || generateId();
      case ChannelType.SMS: return body.phoneNumber || generateId();
      case ChannelType.WEB_CHAT: return generateId();
      case ChannelType.EMAIL: return body.fromEmail || generateId();
      default: return generateId();
    }
  }

  private defaultCapabilities(channelType: ChannelType): Record<string, unknown> {
    switch (channelType) {
      case ChannelType.WHATSAPP:
        return { supportsTemplates: true, supportsInteractive: true, supportsMedia: true, supportsVoice: false };
      case ChannelType.INSTAGRAM:
        return { supportsTemplates: false, supportsInteractive: true, supportsMedia: true, supportsVoice: false };
      case ChannelType.SMS:
        return { supportsTemplates: false, supportsInteractive: false, supportsMedia: true, supportsVoice: false };
      case ChannelType.WEB_CHAT:
        return { supportsTemplates: false, supportsInteractive: true, supportsMedia: true, supportsVoice: false };
      case ChannelType.EMAIL:
        return { supportsTemplates: true, supportsInteractive: false, supportsMedia: true, supportsVoice: false };
      default: return {};
    }
  }
}
