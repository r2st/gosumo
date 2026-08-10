import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { notification_templates } from '@prisma/client';
import { Prisma, NotificationTemplateChannel } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { QUICK_REPLY_CATEGORY } from './message.constants';

export interface CreateTemplateInput {
  channel: NotificationTemplateChannel;
  name: string;
  /** Channel-specific structure; must include a `body` string for rendering. */
  content: Record<string, unknown>;
  /** Declared variable names, e.g. ["customerName", "orderId"]. */
  variables?: string[];
  category?: string;
  language?: string;
  externalName?: string;
}

export interface RenderedTemplate {
  templateId: string;
  name: string;
  channel: NotificationTemplateChannel;
  /** Body with all {{placeholders}} substituted. */
  body: string;
  /** Variable names that were declared but not supplied a value. */
  missingVariables: string[];
}

/**
 * MessageTemplateService — manages reusable message templates and short
 * "quick reply" snippets, backed by the `notification_templates` table.
 *
 * Templates carry `{{placeholder}}` tokens in their `content.body`; `render()`
 * substitutes supplied variables and reports any that were left unfilled.
 */
@Injectable()
export class MessageTemplateService {
  private readonly logger = new Logger(MessageTemplateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Create a reusable template for a business. */
  async createTemplate(
    businessId: string,
    input: CreateTemplateInput,
  ): Promise<notification_templates> {
    return this.prisma.notification_templates.create({
      data: {
        business_id: businessId,
        channel: input.channel,
        name: input.name,
        external_name: input.externalName ?? null,
        content: input.content as Prisma.InputJsonValue,
        variables: (input.variables ?? []) as unknown as Prisma.InputJsonValue,
        category: input.category ?? null,
        language: input.language ?? 'en',
      },
    });
  }

  /** Create a short canned quick-reply snippet. */
  async createQuickReply(
    businessId: string,
    name: string,
    body: string,
    channel: NotificationTemplateChannel = NotificationTemplateChannel.WHATSAPP,
  ): Promise<notification_templates> {
    return this.createTemplate(businessId, {
      channel,
      name,
      content: { body },
      category: QUICK_REPLY_CATEGORY,
    });
  }

  /** List active templates for a business, optionally filtered by channel/category. */
  async listTemplates(
    businessId: string,
    filters: {
      channel?: NotificationTemplateChannel;
      category?: string;
    } = {},
  ): Promise<notification_templates[]> {
    const where: Prisma.notification_templatesWhereInput = {
      business_id: businessId,
      is_active: true,
      deleted_at: null,
    };
    if (filters.channel) where.channel = filters.channel;
    if (filters.category) where.category = filters.category;

    return this.prisma.notification_templates.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  /** List the business's quick-reply snippets. */
  async listQuickReplies(
    businessId: string,
    channel?: NotificationTemplateChannel,
  ): Promise<notification_templates[]> {
    return this.listTemplates(businessId, {
      channel,
      category: QUICK_REPLY_CATEGORY,
    });
  }

  /** Fetch a single template, scoped to the business. */
  async getTemplate(
    businessId: string,
    templateId: string,
  ): Promise<notification_templates> {
    const template = await this.prisma.notification_templates.findFirst({
      where: { id: templateId, business_id: businessId, deleted_at: null },
    });
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }
    return template;
  }

  /**
   * Render a template's body with the supplied variables. Placeholders use the
   * `{{name}}` syntax. Missing variables are left as the literal token and
   * reported in `missingVariables`.
   */
  async renderTemplate(
    businessId: string,
    templateId: string,
    variables: Record<string, string> = {},
  ): Promise<RenderedTemplate> {
    const template = await this.getTemplate(businessId, templateId);
    const content = template.content as Record<string, unknown>;
    const rawBody = typeof content.body === 'string' ? content.body : '';

    const missing = new Set<string>();
    const body = rawBody.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
      if (Object.prototype.hasOwnProperty.call(variables, key)) {
        return variables[key] ?? '';
      }
      missing.add(key);
      return `{{${key}}}`;
    });

    return {
      templateId: template.id,
      name: template.name,
      channel: template.channel,
      body,
      missingVariables: Array.from(missing),
    };
  }

  /** Soft-delete a template. */
  async deleteTemplate(businessId: string, templateId: string): Promise<void> {
    await this.getTemplate(businessId, templateId);
    await this.prisma.notification_templates.update({
      where: { id: templateId, business_id: businessId },
      data: { deleted_at: new Date(), is_active: false },
    });
  }
}
