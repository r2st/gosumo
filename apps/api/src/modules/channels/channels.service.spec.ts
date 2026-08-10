/**
 * ChannelsService unit tests.
 *
 * `channels.spec.ts` covers the controller with the service mocked out, which
 * left the service itself at zero branch coverage. This drives the real service
 * against a mocked Prisma and ConfigService.
 *
 * The weight here is on the per-channel switches — credential shapes, external
 * id derivation, capability flags, connection probes. They are five-armed and
 * near-identical, which is exactly where a wrong arm hides: WhatsApp reading
 * Instagram's page id fails loudly, but SMS silently defaulting to the wrong
 * provider does not.
 */

import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@gosumo/shared';

import { ChannelsService } from './channels.service';
import { decryptJson, encryptJson } from '../../common/utils/encryption.util';
import type { PrismaService } from '../../common/services/prisma.service';
import type { ConnectChannelDto } from './dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CHANNEL_ID = '00000000-0000-4000-b000-000000000001';

type ChannelRow = Record<string, unknown>;

function row(overrides: ChannelRow = {}): ChannelRow {
  return {
    id: CHANNEL_ID,
    business_id: BUSINESS_ID,
    channel: ChannelType.WHATSAPP,
    name: 'Support',
    external_id: 'pn-1',
    external_account: null,
    credentials: encryptJson({ accessToken: 'tok-abcdef' }),
    webhook_url: 'https://api.gosumo.ai/v1/webhooks/whatsapp',
    is_active: true,
    is_verified: true,
    metadata: {},
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

describe('ChannelsService', () => {
  let service: ChannelsService;
  let prisma: {
    channel_accounts: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let config: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      channel_accounts: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    // Default: the typed `app.apiBaseUrl` key resolves.
    config = {
      get: jest.fn((key: string) =>
        key === 'app.apiBaseUrl' ? 'https://api.test' : undefined,
      ),
    };

    service = new ChannelsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────
  // listChannels
  // ─────────────────────────────────────────────

  describe('listChannels', () => {
    it('scopes the query to the tenant and to undeleted rows', async () => {
      prisma.channel_accounts.findMany.mockResolvedValue([]);

      await service.listChannels(BUSINESS_ID);

      expect(prisma.channel_accounts.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'desc' },
      });
    });

    it('reports an empty page rather than omitting the envelope', async () => {
      prisma.channel_accounts.findMany.mockResolvedValue([]);

      await expect(service.listChannels(BUSINESS_ID)).resolves.toEqual({
        data: [],
        total: 0,
        hasMore: false,
        cursor: null,
      });
    });

    it('serialises every row and counts them', async () => {
      prisma.channel_accounts.findMany.mockResolvedValue([row(), row()]);

      const result = await service.listChannels(BUSINESS_ID);

      expect(result.total).toBe(2);
      expect(result.data[0]).toMatchObject({
        id: CHANNEL_ID,
        businessId: BUSINESS_ID,
        type: ChannelType.WHATSAPP,
        status: 'CONNECTED',
      });
    });
  });

  // ─────────────────────────────────────────────
  // connectChannel
  // ─────────────────────────────────────────────

  describe('connectChannel', () => {
    it('creates a new account when none matches', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockImplementation(
        ({ data }: { data: ChannelRow }) => Promise.resolve(row(data)),
      );

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-9',
        accessToken: 'tok',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.update).not.toHaveBeenCalled();
      expect(prisma.channel_accounts.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: BUSINESS_ID,
            channel: ChannelType.WHATSAPP,
            external_id: 'pn-9',
            is_verified: false,
          }),
        }),
      );
    });

    it('reconnects an existing account instead of creating a duplicate', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(row());
      prisma.channel_accounts.update.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.create).not.toHaveBeenCalled();
      expect(prisma.channel_accounts.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CHANNEL_ID, business_id: BUSINESS_ID },
        }),
      );
    });

    it('clears deleted_at when reconnecting, so a disconnected channel revives', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ deleted_at: new Date('2026-02-01T00:00:00Z') }),
      );
      prisma.channel_accounts.update.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
      } as ConnectChannelDto);

      const { data } = prisma.channel_accounts.update.mock.calls[0][0];
      expect(data.deleted_at).toBeNull();
      expect(data.is_active).toBe(true);
    });

    it('scopes the duplicate check to the tenant', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.SMS, {
        phoneNumber: '+919876543210',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          channel: ChannelType.SMS,
          external_id: '+919876543210',
          deleted_at: null,
        },
      });
    });

    it('falls back to a generated display name', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.EMAIL, {
        fromEmail: 'hi@shop.in',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.create.mock.calls[0][0].data.name).toBe(
        'EMAIL Channel',
      );
    });

    it('prefers an explicit display name', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.EMAIL, {
        fromEmail: 'hi@shop.in',
        displayName: 'Storefront Inbox',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.create.mock.calls[0][0].data.name).toBe(
        'Storefront Inbox',
      );
    });

    it('builds the webhook URL from the lower-cased channel type', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WEB_CHAT, {
        title: 'Hi',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.webhook_url,
      ).toBe('https://api.test/v1/webhooks/web_chat');
    });

    it('falls back to the untyped API_BASE_URL key', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'API_BASE_URL' ? 'https://legacy.test' : undefined,
      );
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.webhook_url,
      ).toBe('https://legacy.test/v1/webhooks/whatsapp');
    });

    it('falls back to the production host when neither key is configured', async () => {
      config.get.mockReturnValue(undefined);
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.webhook_url,
      ).toBe('https://api.gosumo.ai/v1/webhooks/whatsapp');
    });

    it('stores the widget config for web chat', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WEB_CHAT, {
        widgetConfig: { position: 'bottom-right' },
      } as unknown as ConnectChannelDto);

      expect(prisma.channel_accounts.create.mock.calls[0][0].data.metadata).toEqual(
        { widgetConfig: { position: 'bottom-right' } },
      );
    });

    it('ignores a widget config supplied for a non-web-chat channel', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
        widgetConfig: { position: 'bottom-right' },
      } as unknown as ConnectChannelDto);

      expect(prisma.channel_accounts.create.mock.calls[0][0].data.metadata).toEqual(
        {},
      );
    });

    it('carries title and primary colour into metadata', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WEB_CHAT, {
        title: 'Talk to us',
        primaryColor: '#ff0000',
      } as ConnectChannelDto);

      expect(prisma.channel_accounts.create.mock.calls[0][0].data.metadata).toEqual(
        { title: 'Talk to us', primaryColor: '#ff0000' },
      );
    });

    it('records the WABA id as the external account', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
        wabaId: 'waba-7',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.external_account,
      ).toBe('waba-7');
    });

    it('records the page id as the external account when there is no WABA id', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.INSTAGRAM, {
        pageId: 'page-3',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.external_account,
      ).toBe('page-3');
    });

    it('leaves the external account null when neither id is supplied', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WEB_CHAT, {
        title: 'Hi',
      } as ConnectChannelDto);

      expect(
        prisma.channel_accounts.create.mock.calls[0][0].data.external_account,
      ).toBeNull();
    });

    it('encrypts credentials rather than storing them in the clear', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
        accessToken: 'super-secret-token',
      } as ConnectChannelDto);

      const stored = prisma.channel_accounts.create.mock.calls[0][0].data
        .credentials as string;
      expect(stored).not.toContain('super-secret-token');
    });
  });

  // ─────────────────────────────────────────────
  // Credential shapes, external ids, capabilities
  // ─────────────────────────────────────────────

  describe('credential building', () => {
    async function credentialsFor(
      channelType: ChannelType,
      body: Partial<ConnectChannelDto>,
    ): Promise<Record<string, unknown>> {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockImplementation(
        ({ data }: { data: ChannelRow }) => Promise.resolve(row(data)),
      );

      await service.connectChannel(
        BUSINESS_ID,
        channelType,
        body as ConnectChannelDto,
      );

      const stored = prisma.channel_accounts.create.mock.calls[0][0].data
        .credentials as string;
      // Round-trips through the same decrypt the service uses on read.
      return decryptJson(stored);
    }

    it('passes an explicit credentials bag through untouched', async () => {
      const creds = await credentialsFor(ChannelType.WHATSAPP, {
        credentials: { custom: 'value' },
        phoneNumberId: 'ignored',
      } as Partial<ConnectChannelDto>);

      expect(creds).toEqual({ custom: 'value' });
    });

    it('ignores an empty credentials bag and derives from the body', async () => {
      const creds = await credentialsFor(ChannelType.WHATSAPP, {
        credentials: {},
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
      } as Partial<ConnectChannelDto>);

      expect(creds).toMatchObject({ phoneNumberId: 'pn-1', accessToken: 'tok' });
    });

    it('builds the WhatsApp credential shape', async () => {
      const creds = await credentialsFor(ChannelType.WHATSAPP, {
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        accessToken: 'tok',
        appSecret: 'sec',
      } as Partial<ConnectChannelDto>);

      expect(creds).toEqual({
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        accessToken: 'tok',
        appSecret: 'sec',
      });
    });

    it('builds the Instagram credential shape', async () => {
      const creds = await credentialsFor(ChannelType.INSTAGRAM, {
        pageId: 'page-1',
        accessToken: 'tok',
        appSecret: 'sec',
      } as Partial<ConnectChannelDto>);

      expect(creds).toEqual({
        pageId: 'page-1',
        accessToken: 'tok',
        appSecret: 'sec',
      });
    });

    it('defaults the SMS provider to twilio', async () => {
      const creds = await credentialsFor(ChannelType.SMS, {
        accountSid: 'AC1',
        authToken: 'tok',
        phoneNumber: '+919876543210',
      } as Partial<ConnectChannelDto>);

      expect(creds.provider).toBe('twilio');
    });

    it('honours an explicit SMS provider', async () => {
      const creds = await credentialsFor(ChannelType.SMS, {
        provider: 'msg91',
        phoneNumber: '+919876543210',
      } as Partial<ConnectChannelDto>);

      expect(creds.provider).toBe('msg91');
    });

    it('defaults the web-chat title and colour', async () => {
      const creds = await credentialsFor(ChannelType.WEB_CHAT, {});

      expect(creds).toEqual({
        title: 'Chat with us',
        primaryColor: '#6366f1',
      });
    });

    it('honours an explicit web-chat title and colour', async () => {
      const creds = await credentialsFor(ChannelType.WEB_CHAT, {
        title: 'Ask us',
        primaryColor: '#000000',
      } as Partial<ConnectChannelDto>);

      expect(creds).toEqual({ title: 'Ask us', primaryColor: '#000000' });
    });

    it('builds the email credential shape', async () => {
      const creds = await credentialsFor(ChannelType.EMAIL, {
        fromEmail: 'hi@shop.in',
        fromName: 'Shop',
      } as Partial<ConnectChannelDto>);

      expect(creds).toMatchObject({
        fromEmail: 'hi@shop.in',
        fromName: 'Shop',
      });
    });

    it('returns an empty bag for an unrecognised channel type', async () => {
      const creds = await credentialsFor(
        'TELEGRAM' as ChannelType,
        {} as Partial<ConnectChannelDto>,
      );

      expect(creds).toEqual({});
    });
  });

  describe('external id derivation', () => {
    async function externalIdFor(
      channelType: ChannelType,
      body: Partial<ConnectChannelDto>,
    ): Promise<string> {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(
        BUSINESS_ID,
        channelType,
        body as ConnectChannelDto,
      );

      return prisma.channel_accounts.create.mock.calls[0][0].data
        .external_id as string;
    }

    it('uses the WhatsApp phone number id', async () => {
      expect(
        await externalIdFor(ChannelType.WHATSAPP, {
          phoneNumberId: 'pn-1',
        } as Partial<ConnectChannelDto>),
      ).toBe('pn-1');
    });

    it('uses the Instagram page id', async () => {
      expect(
        await externalIdFor(ChannelType.INSTAGRAM, {
          pageId: 'page-1',
        } as Partial<ConnectChannelDto>),
      ).toBe('page-1');
    });

    it('uses the SMS phone number', async () => {
      expect(
        await externalIdFor(ChannelType.SMS, {
          phoneNumber: '+919876543210',
        } as Partial<ConnectChannelDto>),
      ).toBe('+919876543210');
    });

    it('uses the from address for email', async () => {
      expect(
        await externalIdFor(ChannelType.EMAIL, {
          fromEmail: 'hi@shop.in',
        } as Partial<ConnectChannelDto>),
      ).toBe('hi@shop.in');
    });

    it('always generates an id for web chat', async () => {
      const id = await externalIdFor(ChannelType.WEB_CHAT, {
        title: 'Hi',
      } as Partial<ConnectChannelDto>);

      expect(id).toEqual(expect.any(String));
      expect(id.length).toBeGreaterThan(0);
    });

    it.each([
      [ChannelType.WHATSAPP],
      [ChannelType.INSTAGRAM],
      [ChannelType.SMS],
      [ChannelType.EMAIL],
      ['TELEGRAM' as ChannelType],
    ])('generates an id when %s supplies none', async (channelType) => {
      const id = await externalIdFor(channelType, {});

      expect(id).toEqual(expect.any(String));
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('default capabilities', () => {
    async function capabilitiesFor(
      channelType: ChannelType,
    ): Promise<Record<string, unknown>> {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);
      prisma.channel_accounts.create.mockResolvedValue(row());

      await service.connectChannel(BUSINESS_ID, channelType, {
        phoneNumberId: 'pn-1',
        pageId: 'page-1',
        phoneNumber: '+919876543210',
        fromEmail: 'hi@shop.in',
      } as ConnectChannelDto);

      return prisma.channel_accounts.create.mock.calls[0][0].data
        .capabilities as Record<string, unknown>;
    }

    it('marks templates supported on WhatsApp', async () => {
      expect(await capabilitiesFor(ChannelType.WHATSAPP)).toEqual({
        supportsTemplates: true,
        supportsInteractive: true,
        supportsMedia: true,
        supportsVoice: false,
      });
    });

    it('marks templates unsupported on Instagram', async () => {
      expect(await capabilitiesFor(ChannelType.INSTAGRAM)).toMatchObject({
        supportsTemplates: false,
        supportsInteractive: true,
      });
    });

    it('marks SMS non-interactive', async () => {
      expect(await capabilitiesFor(ChannelType.SMS)).toMatchObject({
        supportsTemplates: false,
        supportsInteractive: false,
      });
    });

    it('marks web chat interactive but template-less', async () => {
      expect(await capabilitiesFor(ChannelType.WEB_CHAT)).toMatchObject({
        supportsTemplates: false,
        supportsInteractive: true,
      });
    });

    it('marks email templated but non-interactive', async () => {
      expect(await capabilitiesFor(ChannelType.EMAIL)).toMatchObject({
        supportsTemplates: true,
        supportsInteractive: false,
      });
    });

    it('claims no capabilities for an unrecognised channel type', async () => {
      expect(await capabilitiesFor('TELEGRAM' as ChannelType)).toEqual({});
    });

    it('never claims voice support on any channel', async () => {
      for (const channelType of [
        ChannelType.WHATSAPP,
        ChannelType.INSTAGRAM,
        ChannelType.SMS,
        ChannelType.WEB_CHAT,
        ChannelType.EMAIL,
      ]) {
        jest.clearAllMocks();
        expect(await capabilitiesFor(channelType)).toMatchObject({
          supportsVoice: false,
        });
      }
    });
  });

  // ─────────────────────────────────────────────
  // disconnectChannel
  // ─────────────────────────────────────────────

  describe('disconnectChannel', () => {
    it('soft-deletes rather than removing the row', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(row());
      prisma.channel_accounts.update.mockResolvedValue(row());

      await service.disconnectChannel(BUSINESS_ID, CHANNEL_ID);

      const { data } = prisma.channel_accounts.update.mock.calls[0][0];
      expect(data.deleted_at).toBeInstanceOf(Date);
      expect(data.is_active).toBe(false);
    });

    it('scopes the update to the tenant', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(row());
      prisma.channel_accounts.update.mockResolvedValue(row());

      await service.disconnectChannel(BUSINESS_ID, CHANNEL_ID);

      expect(prisma.channel_accounts.update.mock.calls[0][0].where).toEqual({
        id: CHANNEL_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('rejects a channel belonging to another tenant as not found', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.disconnectChannel(BUSINESS_ID, CHANNEL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.channel_accounts.update).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // testConnection
  // ─────────────────────────────────────────────

  describe('testConnection', () => {
    function mockFetch(impl: jest.Mock): void {
      global.fetch = impl as unknown as typeof fetch;
    }

    it('rejects a channel belonging to another tenant as not found', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.testConnection(BUSINESS_ID, CHANNEL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('verifies WhatsApp against the Graph API', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.WHATSAPP,
          credentials: encryptJson({
            phoneNumberId: 'pn-42',
            accessToken: 'tok',
          }),
        }),
      );
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      mockFetch(fetchMock);

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toContain('/v19.0/pn-42');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer tok',
      );
    });

    it('falls back to the stored external id when WhatsApp credentials omit one', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.WHATSAPP,
          external_id: 'pn-stored',
          credentials: encryptJson({ accessToken: 'tok' }),
        }),
      );
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      mockFetch(fetchMock);

      await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(fetchMock.mock.calls[0][0]).toContain('/v19.0/pn-stored');
    });

    it('surfaces a WhatsApp API error with its status and body', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WHATSAPP }),
      );
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('invalid token'),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
      expect(result.message).toContain('invalid token');
    });

    it('verifies Instagram against the Graph API', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.INSTAGRAM,
          credentials: encryptJson({ pageId: 'page-9', accessToken: 'tok' }),
        }),
      );
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      mockFetch(fetchMock);

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toContain(
        'page-9?fields=instagram_business_account',
      );
    });

    it('falls back to the stored external id when Instagram credentials omit a page id', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.INSTAGRAM,
          external_id: 'page-stored',
          credentials: encryptJson({ accessToken: 'tok' }),
        }),
      );
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      mockFetch(fetchMock);

      await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(fetchMock.mock.calls[0][0]).toContain('page-stored');
    });

    it('surfaces an Instagram API error', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.INSTAGRAM }),
      );
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('bad page'),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Instagram API error 400');
    });

    it('verifies SMS with basic auth against Twilio', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.SMS,
          credentials: encryptJson({ accountSid: 'AC1', authToken: 'sec' }),
        }),
      );
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      mockFetch(fetchMock);

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toContain('Accounts/AC1.json');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Basic ' + Buffer.from('AC1:sec').toString('base64'),
      );
    });

    it('surfaces a Twilio API error', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.SMS,
          credentials: encryptJson({ accountSid: 'AC1', authToken: 'sec' }),
        }),
      );
      mockFetch(
        jest.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: () => Promise.resolve('forbidden'),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Twilio API error 403');
    });

    it('reports web chat healthy without any network call', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );
      const fetchMock = jest.fn();
      mockFetch(fetchMock);

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result).toMatchObject({
        success: true,
        message: 'Web Chat is self-contained',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports email healthy when a from address is configured', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.EMAIL,
          credentials: encryptJson({ fromEmail: 'hi@shop.in' }),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(true);
      expect(result.message).toContain('hi@shop.in');
    });

    it('falls back to the stored external id as the email from address', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.EMAIL,
          external_id: 'stored@shop.in',
          credentials: encryptJson({}),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.message).toContain('stored@shop.in');
    });

    it('reports email unhealthy when no from address exists anywhere', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.EMAIL,
          external_id: '',
          credentials: encryptJson({}),
        }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result).toMatchObject({
        success: false,
        message: 'No fromEmail configured',
      });
    });

    it('reports an unrecognised channel type rather than throwing', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: 'TELEGRAM' }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown channel type: TELEGRAM');
    });

    it('converts a network failure into a failed probe, not an exception', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WHATSAPP }),
      );
      mockFetch(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('ECONNREFUSED');
    });

    it('stringifies a non-Error rejection', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WHATSAPP }),
      );
      mockFetch(jest.fn().mockRejectedValue('socket hang up'));

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('socket hang up');
    });

    it('reports a latency for every outcome', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );

      const result = await service.testConnection(BUSINESS_ID, CHANNEL_ID);

      expect(result.latencyMs).toEqual(expect.any(Number));
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────
  // getWebChatEmbed
  // ─────────────────────────────────────────────

  describe('getWebChatEmbed', () => {
    it('scopes by tenant when one is present', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );

      await service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID);

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          id: CHANNEL_ID,
          channel: ChannelType.WEB_CHAT,
          deleted_at: null,
          business_id: BUSINESS_ID,
        },
      });
    });

    it('omits the tenant predicate on the unauthenticated path', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );

      await service.getWebChatEmbed('', CHANNEL_ID);

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          id: CHANNEL_ID,
          channel: ChannelType.WEB_CHAT,
          deleted_at: null,
        },
      });
    });

    it('never returns credentials on the unauthenticated path', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.WEB_CHAT,
          credentials: encryptJson({ accessToken: 'super-secret-token' }),
        }),
      );

      const result = await service.getWebChatEmbed('', CHANNEL_ID);

      expect(JSON.stringify(result)).not.toContain('super-secret-token');
      expect(Object.keys(result)).toEqual([
        'widgetId',
        'businessId',
        'config',
        'snippet',
      ]);
    });

    it('returns the stored widget config', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({
          channel: ChannelType.WEB_CHAT,
          metadata: { widgetConfig: { position: 'left' } },
        }),
      );

      const result = await service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID);

      expect(result.config).toEqual({ position: 'left' });
    });

    it('falls back to an empty config when none is stored', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT, metadata: {} }),
      );

      const result = await service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID);

      expect(result.config).toEqual({});
    });

    it('embeds the widget and business ids in the snippet', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );

      const result = await service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID);

      expect(result.snippet).toContain(`data-widget-id="${CHANNEL_ID}"`);
      expect(result.snippet).toContain(`data-business-id="${BUSINESS_ID}"`);
      expect(result.snippet).toContain('https://api.test/v1/webchat/widget.js');
    });

    it('falls back to the production host in the snippet', async () => {
      config.get.mockReturnValue(undefined);
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ channel: ChannelType.WEB_CHAT }),
      );

      const result = await service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID);

      expect(result.snippet).toContain('https://api.gosumo.ai/v1/webchat/widget.js');
    });

    it('reports an unknown widget as not found', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.getWebChatEmbed(BUSINESS_ID, CHANNEL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // getChannelCredentials
  // ─────────────────────────────────────────────

  describe('getChannelCredentials', () => {
    it('decrypts the stored credentials', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(
        row({ credentials: encryptJson({ accessToken: 'tok', appSecret: 's' }) }),
      );

      await expect(
        service.getChannelCredentials(BUSINESS_ID, CHANNEL_ID),
      ).resolves.toEqual({ accessToken: 'tok', appSecret: 's' });
    });

    it('scopes the lookup to the tenant, so a foreign id cannot read secrets', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.getChannelCredentials(BUSINESS_ID, CHANNEL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          id: CHANNEL_ID,
          business_id: BUSINESS_ID,
          deleted_at: null,
        },
      });
    });
  });

  // ─────────────────────────────────────────────
  // findByExternalId
  // ─────────────────────────────────────────────

  describe('findByExternalId', () => {
    it('resolves an active account by provider identifier', async () => {
      const account = row();
      prisma.channel_accounts.findFirst.mockResolvedValue(account);

      await expect(
        service.findByExternalId(ChannelType.WHATSAPP, 'pn-1'),
      ).resolves.toBe(account);

      expect(prisma.channel_accounts.findFirst).toHaveBeenCalledWith({
        where: {
          channel: ChannelType.WHATSAPP,
          external_id: 'pn-1',
          is_active: true,
          deleted_at: null,
        },
      });
    });

    it('does not resolve a disconnected account', async () => {
      prisma.channel_accounts.findFirst.mockResolvedValue(null);

      await expect(
        service.findByExternalId(ChannelType.WHATSAPP, 'pn-gone'),
      ).resolves.toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // Response serialisation
  // ─────────────────────────────────────────────

  describe('channel response serialisation', () => {
    async function serialise(overrides: ChannelRow): Promise<
      Record<string, unknown>
    > {
      prisma.channel_accounts.findMany.mockResolvedValue([row(overrides)]);
      const { data } = await service.listChannels(BUSINESS_ID);
      return data[0] as unknown as Record<string, unknown>;
    }

    it('reports an active verified channel as connected', async () => {
      expect(
        await serialise({ is_active: true, is_verified: true }),
      ).toMatchObject({ status: 'CONNECTED' });
    });

    it('reports an active unverified channel as pending', async () => {
      expect(
        await serialise({ is_active: true, is_verified: false }),
      ).toMatchObject({ status: 'PENDING' });
    });

    it('reports an inactive channel as disconnected', async () => {
      expect(
        await serialise({ is_active: false, is_verified: true }),
      ).toMatchObject({ status: 'DISCONNECTED' });
    });

    it('reports a soft-deleted channel as disconnected even when still active', async () => {
      expect(
        await serialise({
          deleted_at: new Date('2026-03-01T00:00:00Z'),
          is_active: true,
          is_verified: true,
        }),
      ).toMatchObject({ status: 'DISCONNECTED' });
    });

    it('masks secret credential fields', async () => {
      const result = await serialise({
        credentials: encryptJson({ accessToken: 'abcdefgh1234' }),
      });

      expect(result.credentials).toEqual({
        accessToken: { set: true, last4: '1234' },
      });
      expect(JSON.stringify(result)).not.toContain('abcdefgh1234');
    });

    it('survives credentials that cannot be decrypted', async () => {
      const result = await serialise({ credentials: 'not-decryptable-@@@' });

      expect(result.credentials).toEqual({});
      expect(result.status).toBe('CONNECTED');
    });

    it('normalises a missing webhook URL to null', async () => {
      expect(await serialise({ webhook_url: null })).toMatchObject({
        webhookUrl: null,
      });
    });

    it('normalises missing metadata to an empty object', async () => {
      expect(await serialise({ metadata: null })).toMatchObject({
        metadata: {},
      });
    });

    it('serialises timestamps as ISO strings', async () => {
      const result = await serialise({});

      expect(result.connectedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(result.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('falls back to an empty string when timestamps are absent', async () => {
      const result = await serialise({ created_at: null, updated_at: null });

      expect(result.connectedAt).toBe('');
      expect(result.updatedAt).toBe('');
    });
  });
});
