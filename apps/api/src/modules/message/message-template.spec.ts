/**
 * MessageTemplateService unit tests — template CRUD, quick replies, and the
 * {{variable}} rendering engine.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationTemplateChannel } from '@prisma/client';
import { MessageTemplateService } from './message-template.service';
import { PrismaService } from '../../common/services/prisma.service';
import { QUICK_REPLY_CATEGORY } from './message.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const TEMPLATE_ID = '22222222-2222-2222-2222-222222222222';

function createMockPrisma() {
  return {
    notification_templates: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe('MessageTemplateService', () => {
  let service: MessageTemplateService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageTemplateService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<MessageTemplateService>(MessageTemplateService);
  });

  describe('createTemplate', () => {
    it('persists a template with its variables', async () => {
      prisma.notification_templates.create.mockResolvedValue({ id: TEMPLATE_ID });

      await service.createTemplate(BUSINESS_ID, {
        channel: NotificationTemplateChannel.WHATSAPP,
        name: 'order_confirmed',
        content: { body: 'Hi {{name}}' },
        variables: ['name'],
      });

      expect(prisma.notification_templates.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: BUSINESS_ID,
            name: 'order_confirmed',
            variables: ['name'],
          }),
        }),
      );
    });
  });

  describe('createQuickReply', () => {
    it('stores a quick reply under the QUICK_REPLY category', async () => {
      prisma.notification_templates.create.mockResolvedValue({ id: TEMPLATE_ID });

      await service.createQuickReply(BUSINESS_ID, 'greeting', 'Namaste! 🙏');

      expect(prisma.notification_templates.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category: QUICK_REPLY_CATEGORY,
            content: { body: 'Namaste! 🙏' },
          }),
        }),
      );
    });
  });

  describe('listTemplates', () => {
    it('scopes by business and active flag', async () => {
      prisma.notification_templates.findMany.mockResolvedValue([]);

      await service.listTemplates(BUSINESS_ID, {
        channel: NotificationTemplateChannel.SMS,
      });

      expect(prisma.notification_templates.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            business_id: BUSINESS_ID,
            is_active: true,
            deleted_at: null,
            channel: NotificationTemplateChannel.SMS,
          }),
        }),
      );
    });

    it('filters by category when one is supplied', async () => {
      prisma.notification_templates.findMany.mockResolvedValue([]);

      await service.listTemplates(BUSINESS_ID, { category: 'billing' });

      expect(prisma.notification_templates.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: 'billing' }),
        }),
      );
    });

    it('applies no optional filter keys when none are supplied', async () => {
      // An undefined `channel` must be *absent* from the where clause, not
      // present as undefined — Prisma treats `channel: undefined` as "ignore",
      // but the distinction is easy to break and silently widens the query.
      prisma.notification_templates.findMany.mockResolvedValue([]);

      await service.listTemplates(BUSINESS_ID);

      const where = (
        prisma.notification_templates.findMany.mock.calls[0]![0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toEqual({
        business_id: BUSINESS_ID,
        is_active: true,
        deleted_at: null,
      });
    });

    it('always scopes to the business even with no filters', async () => {
      prisma.notification_templates.findMany.mockResolvedValue([]);

      await service.listTemplates(BUSINESS_ID);

      const where = (
        prisma.notification_templates.findMany.mock.calls[0]![0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where['business_id']).toBe(BUSINESS_ID);
    });
  });

  describe('getTemplate', () => {
    it('throws NotFound when absent', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue(null);
      await expect(
        service.getTemplate(BUSINESS_ID, TEMPLATE_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('renderTemplate', () => {
    it('substitutes supplied variables', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'order_confirmed',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: 'Hi {{name}}, order {{orderId}} is confirmed.' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID, {
        name: 'Asha',
        orderId: 'GS-1001',
      });

      expect(result.body).toBe('Hi Asha, order GS-1001 is confirmed.');
      expect(result.missingVariables).toEqual([]);
    });

    it('reports missing variables and leaves the token intact', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'reminder',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: 'Hi {{name}}, see you at {{time}}.' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID, {
        name: 'Asha',
      });

      expect(result.body).toBe('Hi Asha, see you at {{time}}.');
      expect(result.missingVariables).toEqual(['time']);
    });

    it('reports every placeholder as missing when no variables are passed', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'reminder',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: 'Hi {{name}}, see you at {{time}}.' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(result.body).toBe('Hi {{name}}, see you at {{time}}.');
      expect(result.missingVariables).toEqual(['name', 'time']);
    });

    it('renders a supplied-but-empty variable as empty, not as missing', async () => {
      // `hasOwnProperty` is the test, not truthiness: a caller that explicitly
      // passes an empty value has supplied it. Treating it as missing would
      // leave a raw {{token}} in a message that goes out to a customer.
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'greeting',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: 'Hi{{suffix}}!' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID, { suffix: '' });

      expect(result.body).toBe('Hi!');
      expect(result.missingVariables).toEqual([]);
    });

    it('renders an explicitly undefined variable as empty', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'greeting',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: 'Hi{{suffix}}!' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID, {
        suffix: undefined as unknown as string,
      });

      expect(result.body).toBe('Hi!');
      expect(result.missingVariables).toEqual([]);
    });

    it('renders an empty body when the stored content has no body string', async () => {
      // `content` is JSONB, so nothing at the database level guarantees a body
      // field or its type. A template written by an older shape must render as
      // empty rather than crash the send.
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'broken',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { header: 'no body here' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID, { name: 'Asha' });

      expect(result.body).toBe('');
      expect(result.missingVariables).toEqual([]);
    });

    it('renders an empty body when content.body is not a string', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'broken',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: { nested: 'object' } },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(result.body).toBe('');
    });

    it('does not report the same missing placeholder twice', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'repeat',
        channel: NotificationTemplateChannel.WHATSAPP,
        content: { body: '{{name}} and {{name}} again' },
      });

      const result = await service.renderTemplate(BUSINESS_ID, TEMPLATE_ID);

      expect(result.missingVariables).toEqual(['name']);
    });
  });

  describe('deleteTemplate', () => {
    it('soft-deletes the template', async () => {
      prisma.notification_templates.findFirst.mockResolvedValue({ id: TEMPLATE_ID });
      prisma.notification_templates.update.mockResolvedValue({});

      await service.deleteTemplate(BUSINESS_ID, TEMPLATE_ID);

      // Scoped by tenant as well as id — a bare-id soft-delete would let one
      // business retire another's template.
      expect(prisma.notification_templates.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TEMPLATE_ID, business_id: BUSINESS_ID },
          data: expect.objectContaining({ is_active: false }),
        }),
      );
    });
  });
});
