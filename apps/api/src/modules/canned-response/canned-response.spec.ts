/**
 * Canned-response module unit tests
 *
 * Coverage:
 *  - create: shortcut conflict (pre-check + DB unique-constraint race),
 *    lowercasing
 *  - list/get/getByShortcut: mapping, 404s
 *  - update/delete: 404 guard
 *  - recordUsage: increments usage_count and emits canned_response.used
 *
 * The repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CannedResponseService } from './canned-response.service';
import { CannedResponseRepository } from './canned-response.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const RESPONSE_ID = '00000000-0000-4000-a000-000000000020';

function makeCannedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: RESPONSE_ID,
    business_id: BUSINESS_ID,
    title: 'Refund policy',
    shortcut: 'refund-policy',
    content: 'Our refund policy is...',
    category: 'billing',
    channel: null,
    tags: ['refund'],
    is_active: true,
    usage_count: 0,
    created_by: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('CannedResponseService', () => {
  let service: CannedResponseService;
  let repo: jest.Mocked<CannedResponseRepository>;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      findByShortcut: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      incrementUsage: jest.fn(),
    } as unknown as jest.Mocked<CannedResponseRepository>;

    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CannedResponseService,
        { provide: CannedResponseRepository, useValue: repo },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(CannedResponseService);
  });

  describe('create', () => {
    it('throws 409 when the shortcut is already taken', async () => {
      repo.findByShortcut.mockResolvedValue(makeCannedResponse());
      await expect(
        service.create(BUSINESS_ID, {
          title: 'Refund policy',
          shortcut: 'refund-policy',
          content: 'x',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('lowercases the shortcut before creating', async () => {
      repo.findByShortcut.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeCannedResponse());

      await service.create(BUSINESS_ID, {
        title: 'Refund policy',
        shortcut: 'Refund-Policy',
        content: 'x',
      });

      expect(repo.create).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ shortcut: 'refund-policy' }),
      );
    });

    it('translates a DB unique-constraint race into 409', async () => {
      repo.findByShortcut.mockResolvedValue(null);
      repo.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflict', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        service.create(BUSINESS_ID, { title: 'x', shortcut: 'x', content: 'x' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('list', () => {
    it('maps entities to DTOs', async () => {
      repo.findMany.mockResolvedValue({
        data: [makeCannedResponse()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const result = await service.list(BUSINESS_ID, {});
      expect(result.data[0]).toMatchObject({ id: RESPONSE_ID, shortcut: 'refund-policy' });
    });
  });

  describe('get / getByShortcut', () => {
    it('throws 404 when not found by id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.get(BUSINESS_ID, RESPONSE_ID)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when not found by shortcut', async () => {
      repo.findByShortcut.mockResolvedValue(null);
      await expect(service.getByShortcut(BUSINESS_ID, 'missing')).rejects.toThrow(NotFoundException);
    });

    it('finds by shortcut case-insensitively', async () => {
      repo.findByShortcut.mockResolvedValue(makeCannedResponse());
      await service.getByShortcut(BUSINESS_ID, 'Refund-Policy');
      expect(repo.findByShortcut).toHaveBeenCalledWith(BUSINESS_ID, 'refund-policy');
    });
  });

  describe('update', () => {
    it('throws 404 for a missing canned response', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update(BUSINESS_ID, RESPONSE_ID, { title: 'New' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updates and maps the result', async () => {
      repo.findById.mockResolvedValue(makeCannedResponse());
      repo.update.mockResolvedValue(makeCannedResponse({ title: 'New title' }));
      const result = await service.update(BUSINESS_ID, RESPONSE_ID, { title: 'New title' });
      expect(result.title).toBe('New title');
    });
  });

  describe('delete', () => {
    it('throws 404 for a missing canned response', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.delete(BUSINESS_ID, RESPONSE_ID)).rejects.toThrow(NotFoundException);
    });

    it('soft-deletes an existing canned response', async () => {
      repo.findById.mockResolvedValue(makeCannedResponse());
      await service.delete(BUSINESS_ID, RESPONSE_ID);
      expect(repo.softDelete).toHaveBeenCalledWith(BUSINESS_ID, RESPONSE_ID);
    });
  });

  describe('recordUsage', () => {
    it('increments usage and emits canned_response.used', async () => {
      repo.findById.mockResolvedValue(makeCannedResponse());
      repo.incrementUsage.mockResolvedValue(makeCannedResponse({ usage_count: 1 }));

      const result = await service.recordUsage(BUSINESS_ID, RESPONSE_ID, 'conv-1', 'agent-1');

      expect(result.usageCount).toBe(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'canned_response.used',
        expect.objectContaining({
          type: 'canned_response.used',
          cannedResponseId: RESPONSE_ID,
          conversationId: 'conv-1',
          usedBy: 'agent-1',
        }),
      );
    });

    it('throws 404 when the canned response is missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.recordUsage(BUSINESS_ID, RESPONSE_ID)).rejects.toThrow(NotFoundException);
    });
  });
});
