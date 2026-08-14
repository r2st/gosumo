import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import type { ConnectChannelDto } from './dto';

/* ─── Mocks ─────────────────────────────────────────────────────────────── */

const mockChannelsService = {
  listChannels: jest.fn(),
  connectChannel: jest.fn(),
  disconnectChannel: jest.fn(),
  testConnection: jest.fn(),
  getWebChatEmbed: jest.fn(),
};

/* ─── Controller tests ──────────────────────────────────────────────────── */

describe('ChannelsController', () => {
  let controller: ChannelsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChannelsController],
      providers: [{ provide: ChannelsService, useValue: mockChannelsService }],
    }).compile();

    controller = module.get<ChannelsController>(ChannelsController);
    jest.clearAllMocks();
  });

  describe('connectChannel — channel type normalisation', () => {
    const businessId = 'biz-001';
    const body = { displayName: 'Test Channel' } as ConnectChannelDto;

    it('should accept lowercase channel type (whatsapp)', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-1' });
      await controller.connectChannel(businessId, 'whatsapp', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.WHATSAPP,
        body,
      );
    });

    it('should accept lowercase channel type (instagram)', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-2' });
      await controller.connectChannel(businessId, 'instagram', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.INSTAGRAM,
        body,
      );
    });

    it('should accept lowercase channel type (sms)', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-3' });
      await controller.connectChannel(businessId, 'sms', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.SMS,
        body,
      );
    });

    it('should accept lowercase channel type (email)', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-4' });
      await controller.connectChannel(businessId, 'email', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.EMAIL,
        body,
      );
    });

    it('should normalise kebab-case web-chat to WEB_CHAT', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-5' });
      await controller.connectChannel(businessId, 'web-chat', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.WEB_CHAT,
        body,
      );
    });

    it('should accept UPPER_SNAKE_CASE WEB_CHAT directly', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-6' });
      await controller.connectChannel(businessId, 'WEB_CHAT', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.WEB_CHAT,
        body,
      );
    });

    it('should accept snake_case web_chat', async () => {
      mockChannelsService.connectChannel.mockResolvedValue({ id: 'ch-7' });
      await controller.connectChannel(businessId, 'web_chat', body);
      expect(mockChannelsService.connectChannel).toHaveBeenCalledWith(
        businessId,
        ChannelType.WEB_CHAT,
        body,
      );
    });

    it('should reject invalid channel types', async () => {
      await expect(
        controller.connectChannel(businessId, 'telegram', body),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject empty channel type', async () => {
      await expect(
        controller.connectChannel(businessId, '', body),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listChannels', () => {
    it('should pass businessId to service', async () => {
      mockChannelsService.listChannels.mockResolvedValue({ data: [], total: 0 });
      const result = await controller.listChannels('biz-001');
      expect(mockChannelsService.listChannels).toHaveBeenCalledWith('biz-001');
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('disconnectChannel', () => {
    it('should pass businessId and channelId', async () => {
      mockChannelsService.disconnectChannel.mockResolvedValue({ success: true });
      await controller.disconnectChannel('biz-001', 'ch-1');
      expect(mockChannelsService.disconnectChannel).toHaveBeenCalledWith('biz-001', 'ch-1');
    });
  });

  describe('testConnection', () => {
    it('should pass businessId and channelId', async () => {
      mockChannelsService.testConnection.mockResolvedValue({
        success: true,
        message: 'OK',
        latencyMs: 10,
      });
      const result = await controller.testConnection('biz-001', 'ch-1');
      expect(result.success).toBe(true);
    });
  });
});

/* ─── Encryption round-trip test ────────────────────────────────────────── */

describe('Encryption utilities', () => {
  // Dynamic import so tests still compile without the file
  let encryptJson: (data: Record<string, unknown>) => string;
  let decryptJson: (encoded: string) => Record<string, unknown>;

  beforeAll(async () => {
    const mod = await import('../../common/utils/encryption.util');
    encryptJson = mod.encryptJson;
    decryptJson = mod.decryptJson;
  });

  it('should round-trip credentials through encrypt/decrypt', () => {
    const creds = {
      phoneNumberId: '12345',
      accessToken: 'EAABx...',
      wabaId: 'waba-001',
    };
    const encrypted = encryptJson(creds);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('EAABx');

    const decrypted = decryptJson(encrypted);
    expect(decrypted).toEqual(creds);
  });

  it('should handle empty credentials', () => {
    const encrypted = encryptJson({});
    const decrypted = decryptJson(encrypted);
    expect(decrypted).toEqual({});
  });

  it('should fall back to {} for garbage input', () => {
    const result = decryptJson('not-valid-base64-at-all');
    expect(result).toEqual({});
  });

  it('should fall back to parsed JSON for plain JSON input', () => {
    const json = JSON.stringify({ key: 'value' });
    const result = decryptJson(json);
    expect(result).toEqual({ key: 'value' });
  });
});
