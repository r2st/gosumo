/**
 * Webhook-log module unit tests
 *
 * Coverage:
 *  - list: threads filters through, maps to summary DTOs (no payload/headers)
 *  - get: 404 when missing, includes payload/headers in the detail DTO
 *  - getStats: default trailing-7-day range, derives unprocessed = total - processed
 *
 * The repository is mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { WebhookLogService } from './webhook-log.service';
import { WebhookLogRepository } from './webhook-log.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const EVENT_ID = '00000000-0000-4000-a000-000000000020';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    business_id: BUSINESS_ID,
    source: 'WHATSAPP',
    event_type: 'message.received',
    external_id: 'wamid.abc123',
    payload: { hello: 'world' },
    headers: { 'x-hub-signature-256': 'sha256=...' },
    processed: true,
    processed_at: new Date('2026-06-01T00:00:05Z'),
    attempts: 1,
    error: null,
    signature_valid: true,
    received_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('WebhookLogService', () => {
  let service: WebhookLogService;
  let repo: jest.Mocked<WebhookLogRepository>;

  beforeEach(async () => {
    repo = {
      findMany: jest.fn(),
      findById: jest.fn(),
      getStats: jest.fn(),
    } as unknown as jest.Mocked<WebhookLogRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookLogService, { provide: WebhookLogRepository, useValue: repo }],
    }).compile();

    service = module.get(WebhookLogService);
  });

  describe('list', () => {
    it('threads filters through and maps to summary DTOs without payload/headers', async () => {
      repo.findMany.mockResolvedValue({
        data: [makeEvent()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const result = await service.list(BUSINESS_ID, { source: 'WHATSAPP' });

      expect(repo.findMany).toHaveBeenCalledWith(BUSINESS_ID, expect.objectContaining({ source: 'WHATSAPP' }));
      expect(result.data[0]).toMatchObject({ id: EVENT_ID, source: 'WHATSAPP', processed: true });
      expect(result.data[0]).not.toHaveProperty('payload');
      expect(result.data[0]).not.toHaveProperty('headers');
    });
  });

  describe('get', () => {
    it('throws 404 when the event does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.get(BUSINESS_ID, EVENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('includes the raw payload and headers in the detail DTO', async () => {
      repo.findById.mockResolvedValue(makeEvent());
      const result = await service.get(BUSINESS_ID, EVENT_ID);
      expect(result.payload).toEqual({ hello: 'world' });
      expect(result.headers).toEqual({ 'x-hub-signature-256': 'sha256=...' });
    });
  });

  describe('getStats', () => {
    it('defaults to a trailing 7-day range and derives unprocessed count', async () => {
      repo.getStats.mockResolvedValue({
        total: 10,
        processed: 7,
        unprocessed: 3,
        invalidSignature: 1,
        bySource: [{ source: 'WHATSAPP', count: 10 }],
      });

      const result = await service.getStats(BUSINESS_ID);

      expect(repo.getStats).toHaveBeenCalledWith(BUSINESS_ID, expect.any(Date), expect.any(Date));
      const spanMs = new Date(result.to).getTime() - new Date(result.from).getTime();
      expect(spanMs).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
      expect(result.unprocessed).toBe(3);
    });
  });
});
