/**
 * Contact module unit tests
 *
 * Coverage:
 *  1. Contacts — list (mapping/pagination), get (404), update (409 on
 *     phone/email conflict), addTags (merge + normalize), removeTags
 *  2. Segments — create (name conflict), list, get (404), update (name
 *     conflict against another segment), delete, member listing
 *
 * The repository and EventEmitter2 are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContactService } from './contact.service';
import { ContactRepository } from './contact.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONTACT_ID = '00000000-0000-4000-a000-000000000020';
const SEGMENT_ID = '00000000-0000-4000-a000-000000000030';

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    business_id: BUSINESS_ID,
    name: 'Asha Rao',
    email: 'asha@example.com',
    phone: '+919876543210',
    avatar_url: null,
    consumer_user_id: null,
    profile: {},
    opt_outs: {},
    tags: ['vip'],
    ltv_score: new Prisma.Decimal(1000),
    churn_risk: new Prisma.Decimal('0.1'),
    engagement_score: new Prisma.Decimal('0.8'),
    scores_updated_at: null,
    total_orders: 3,
    total_spent: new Prisma.Decimal('1500.50'),
    last_interaction_at: new Date('2026-06-01T00:00:00Z'),
    first_seen_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function makeSegment(overrides: Record<string, unknown> = {}) {
  return {
    id: SEGMENT_ID,
    business_id: BUSINESS_ID,
    name: 'High LTV',
    description: null,
    filter: { minLtv: 1000 },
    is_active: true,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('ContactService', () => {
  let service: ContactService;
  let repo: jest.Mocked<ContactRepository>;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      findMany: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      setTags: jest.fn(),
      segmentFilterToWhere: jest.fn(),
      findBySegmentFilter: jest.fn(),
      countBySegmentFilter: jest.fn(),
      createSegment: jest.fn(),
      findSegments: jest.fn(),
      findSegmentById: jest.fn(),
      findSegmentByName: jest.fn(),
      updateSegment: jest.fn(),
      softDeleteSegment: jest.fn(),
    } as unknown as jest.Mocked<ContactRepository>;

    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: ContactRepository, useValue: repo },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(ContactService);
  });

  // ───────────────────────────────────────────
  // Contacts
  // ───────────────────────────────────────────

  describe('listContacts', () => {
    it('maps clients to contact DTOs and threads filters through', async () => {
      repo.findMany.mockResolvedValue({
        data: [makeClient()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const result = await service.listContacts(BUSINESS_ID, { search: 'asha' });

      expect(repo.findMany).toHaveBeenCalledWith(BUSINESS_ID, expect.objectContaining({ search: 'asha' }));
      expect(result.data[0]).toMatchObject({
        id: CONTACT_ID,
        name: 'Asha Rao',
        tags: ['vip'],
        totalSpentPaise: 150050,
        ltvScore: 1000,
      });
    });
  });

  describe('getContact', () => {
    it('throws 404 when the contact does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getContact(BUSINESS_ID, CONTACT_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns the mapped contact when found', async () => {
      repo.findById.mockResolvedValue(makeClient());
      const result = await service.getContact(BUSINESS_ID, CONTACT_ID);
      expect(result.id).toBe(CONTACT_ID);
    });
  });

  describe('updateContact', () => {
    it('throws 409 on a unique constraint violation', async () => {
      repo.findById.mockResolvedValue(makeClient());
      repo.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflict', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        service.updateContact(BUSINESS_ID, CONTACT_ID, { email: 'dup@example.com' }),
      ).rejects.toThrow(ConflictException);
    });

    it('updates and returns the mapped contact', async () => {
      repo.findById.mockResolvedValue(makeClient());
      repo.update.mockResolvedValue(makeClient({ name: 'Asha R.' }));

      const result = await service.updateContact(BUSINESS_ID, CONTACT_ID, { name: 'Asha R.' });
      expect(result.name).toBe('Asha R.');
    });
  });

  describe('addTags / removeTags', () => {
    it('merges new tags with existing ones, normalized and deduplicated', async () => {
      repo.findById.mockResolvedValue(makeClient({ tags: ['vip'] }));
      repo.setTags.mockResolvedValue(makeClient({ tags: ['vip', 'lead'] }));

      await service.addTags(BUSINESS_ID, CONTACT_ID, ['  VIP ', 'Lead']);

      expect(repo.setTags).toHaveBeenCalledWith(BUSINESS_ID, CONTACT_ID, ['vip', 'lead']);
      expect(emitter.emit).toHaveBeenCalledWith('contact.tagged', expect.objectContaining({ type: 'contact.tagged' }));
    });

    it('removes matching tags case-insensitively', async () => {
      repo.findById.mockResolvedValue(makeClient({ tags: ['vip', 'lead'] }));
      repo.setTags.mockResolvedValue(makeClient({ tags: ['lead'] }));

      await service.removeTags(BUSINESS_ID, CONTACT_ID, ['VIP']);

      expect(repo.setTags).toHaveBeenCalledWith(BUSINESS_ID, CONTACT_ID, ['lead']);
    });

    it('throws 404 when tagging a missing contact', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.addTags(BUSINESS_ID, CONTACT_ID, ['vip'])).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────
  // Segments
  // ───────────────────────────────────────────

  describe('createSegment', () => {
    it('throws 409 when a segment with the same name exists', async () => {
      repo.findSegmentByName.mockResolvedValue(makeSegment());
      await expect(
        service.createSegment(BUSINESS_ID, { name: 'High LTV', filter: {} }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates the segment and returns member count', async () => {
      repo.findSegmentByName.mockResolvedValue(null);
      repo.createSegment.mockResolvedValue(makeSegment());
      repo.countBySegmentFilter.mockResolvedValue(5);

      const result = await service.createSegment(BUSINESS_ID, {
        name: 'High LTV',
        filter: { minLtv: 1000 },
      });

      expect(result.memberCount).toBe(5);
      expect(result.name).toBe('High LTV');
    });
  });

  describe('getSegment', () => {
    it('throws 404 when the segment does not exist', async () => {
      repo.findSegmentById.mockResolvedValue(null);
      await expect(service.getSegment(BUSINESS_ID, SEGMENT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateSegment', () => {
    it('throws 409 when renaming to a name used by a different segment', async () => {
      repo.findSegmentById.mockResolvedValue(makeSegment());
      repo.findSegmentByName.mockResolvedValue(makeSegment({ id: 'other-id', name: 'Taken' }));

      await expect(
        service.updateSegment(BUSINESS_ID, SEGMENT_ID, { name: 'Taken' }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows renaming to the same segment\'s own current name', async () => {
      repo.findSegmentById.mockResolvedValue(makeSegment());
      repo.findSegmentByName.mockResolvedValue(makeSegment());
      repo.updateSegment.mockResolvedValue(makeSegment());
      repo.countBySegmentFilter.mockResolvedValue(0);

      await expect(
        service.updateSegment(BUSINESS_ID, SEGMENT_ID, { name: 'High LTV' }),
      ).resolves.toBeDefined();
    });
  });

  describe('deleteSegment', () => {
    it('throws 404 when the segment does not exist', async () => {
      repo.findSegmentById.mockResolvedValue(null);
      await expect(service.deleteSegment(BUSINESS_ID, SEGMENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('soft-deletes an existing segment', async () => {
      repo.findSegmentById.mockResolvedValue(makeSegment());
      await service.deleteSegment(BUSINESS_ID, SEGMENT_ID);
      expect(repo.softDeleteSegment).toHaveBeenCalledWith(BUSINESS_ID, SEGMENT_ID);
    });
  });

  describe('getSegmentMembers', () => {
    it('evaluates the segment filter and returns paginated contacts', async () => {
      repo.findSegmentById.mockResolvedValue(makeSegment());
      repo.findBySegmentFilter.mockResolvedValue({
        data: [makeClient()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const result = await service.getSegmentMembers(BUSINESS_ID, SEGMENT_ID, 1, 20);
      expect(result.data).toHaveLength(1);
      expect(repo.findBySegmentFilter).toHaveBeenCalledWith(BUSINESS_ID, { minLtv: 1000 }, 1, 20);
    });
  });
});
