import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactMergeStrategy } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import type { clients } from '@prisma/client';
import { ContactMergeService } from './contact-merge.service';
import type { ContactMergeRepository } from './contact-merge.repository';
import type { AuditLogService } from '../../../common/services/audit-log.service';

function client(overrides: Partial<clients> = {}): clients {
  return {
    id: 'survivor',
    business_id: 'b1',
    name: 'Asha Iyer',
    email: 'asha@example.in',
    phone: '+919876543210',
    avatar_url: null,
    consumer_user_id: null,
    profile: {},
    opt_outs: {},
    tags: ['vip'],
    ltv_score: null,
    churn_risk: null,
    engagement_score: null,
    scores_updated_at: null,
    total_orders: 2,
    total_spent: new Prisma.Decimal(1000),
    last_interaction_at: new Date('2026-08-01T00:00:00Z'),
    first_seen_at: new Date('2025-01-01T00:00:00Z'),
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date('2026-08-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  } as clients;
}

function makeHarness(
  opts: { survivor?: clients | null; duplicate?: clients | null; merge?: unknown } = {},
) {
  const survivor = 'survivor' in opts ? opts.survivor : client();
  const duplicate =
    'duplicate' in opts
      ? opts.duplicate
      : client({
          id: 'duplicate',
          name: 'A. Iyer',
          email: null,
          phone: '9876543210',
          tags: ['returning'],
          total_orders: 1,
          total_spent: new Prisma.Decimal(500),
          created_at: new Date('2026-01-01T00:00:00Z'),
          first_seen_at: new Date('2026-01-01T00:00:00Z'),
          last_interaction_at: new Date('2026-08-10T00:00:00Z'),
        });

  const repository = {
    findClient: jest.fn().mockImplementation(async (_b, id) => {
      if (id === 'survivor') return survivor;
      if (id === 'duplicate') return duplicate;
      return null;
    }),
    findDedupCandidates: jest.fn().mockResolvedValue([]),
    findExternalIds: jest.fn().mockResolvedValue(new Map()),
    countReferences: jest.fn().mockResolvedValue({ conversations: 3, orders: 1 }),
    executeMerge: jest.fn().mockResolvedValue({
      merge: { id: 'merge-1' },
      survivor,
      execution: {
        counts: { conversations: 3, orders: 1 },
        moved: { conversations: ['c1', 'c2', 'c3'] },
        reversible: true,
        unrecorded: [],
      },
    }),
    findMerge: jest.fn().mockResolvedValue(
      opts.merge ?? {
        id: 'merge-1',
        business_id: 'b1',
        survivor_id: 'survivor',
        duplicate_id: 'duplicate',
        reverted_at: null,
        snapshot: { reversible: true },
      },
    ),
    listMerges: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    revertMerge: jest.fn().mockResolvedValue({ restored: { conversations: 3 } }),
  } as unknown as jest.Mocked<ContactMergeRepository>;

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<
    AuditLogService
  >;
  const eventEmitter = { emit: jest.fn() };

  const service = new ContactMergeService(repository, audit, eventEmitter as never);
  return { service, repository, audit, eventEmitter, survivor, duplicate };
}

describe('ContactMergeService.previewMerge', () => {
  it('refuses to merge a contact into itself', async () => {
    const { service } = makeHarness();
    await expect(service.previewMerge('b1', 'survivor', 'survivor')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404s for a contact outside the tenant', async () => {
    // The worst bug this module could have is a cross-tenant merge.
    const { service } = makeHarness();
    await expect(service.previewMerge('b1', 'survivor', 'someone-elses')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('reports which fields actually conflict', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge('b1', 'survivor', 'duplicate');

    expect(preview.fields['name']!.conflicted).toBe(true);
    // The duplicate has no email, so there is nothing to conflict with.
    expect(preview.fields['email']!.conflicted).toBe(false);
  });

  it('counts the rows that would move without moving them', async () => {
    const { service, repository } = makeHarness();
    const preview = await service.previewMerge('b1', 'survivor', 'duplicate');

    expect(preview.moves).toEqual({ conversations: 3, orders: 1 });
    expect(repository.executeMerge).not.toHaveBeenCalled();
  });
});

describe('ContactMergeService field resolution', () => {
  it('prefers the survivor by default', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge('b1', 'survivor', 'duplicate');

    expect(preview.fields['name']!.chosen).toBe('Asha Iyer');
  });

  it('prefers the duplicate when asked', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.PREFER_DUPLICATE,
    );

    expect(preview.fields['name']!.chosen).toBe('A. Iyer');
  });

  it('never lets a preference erase the only value on file', async () => {
    // PREFER_DUPLICATE with no email on the duplicate must not wipe the
    // survivor's. A merge exists to produce one complete record.
    const { service } = makeHarness();
    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.PREFER_DUPLICATE,
    );

    expect(preview.fields['email']!.chosen).toBe('asha@example.in');
  });

  it('PREFER_MOST_RECENT follows last interaction', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.PREFER_MOST_RECENT,
    );

    // The duplicate interacted more recently (2026-08-10 vs 2026-08-01).
    expect(preview.fields['name']!.chosen).toBe('A. Iyer');
  });

  it('honours explicit per-field overrides under MANUAL', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.MANUAL,
      { name: 'Asha R. Iyer' },
    );

    expect(preview.fields['name']!.chosen).toBe('Asha R. Iyer');
  });

  it('falls back to the strategy for fields MANUAL does not name', async () => {
    const { service } = makeHarness();
    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.MANUAL,
      { name: 'Asha R. Iyer' },
    );

    expect(preview.fields['phone']!.chosen).toBe('+919876543210');
  });

  it('treats a whitespace-only value as absent', async () => {
    const { service } = makeHarness({
      duplicate: client({ id: 'duplicate', name: '   ', email: 'dup@example.in' }),
    });

    const preview = await service.previewMerge(
      'b1',
      'survivor',
      'duplicate',
      ContactMergeStrategy.PREFER_DUPLICATE,
    );

    expect(preview.fields['name']!.chosen).toBe('Asha Iyer');
  });
});

describe('ContactMergeService.merge', () => {
  it('passes the resolved fields through to the transaction', async () => {
    const { service, repository } = makeHarness();
    await service.merge('b1', 'survivor', 'duplicate');

    const params = repository.executeMerge.mock.calls[0]![0]!;
    expect(params.resolved['name']).toBe('Asha Iyer');
    expect(params.survivor.id).toBe('survivor');
    expect(params.duplicate.id).toBe('duplicate');
  });

  it('records the match score and reason on the merge', async () => {
    const { service, repository } = makeHarness();
    await service.merge('b1', 'survivor', 'duplicate');

    const params = repository.executeMerge.mock.calls[0]![0]!;
    // The two share a subscriber number written two ways.
    expect(params.matchScore).toBeGreaterThan(0);
    expect(params.matchReason).toContain('country-code');
  });

  it('audits the merge with what moved', async () => {
    const { service, audit } = makeHarness();
    await service.merge('b1', 'survivor', 'duplicate', { performedBy: 'tm-1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'contact_merge',
        actorId: 'tm-1',
        after: expect.objectContaining({ reversible: true }),
      }),
    );
  });

  it('emits contact.merged', async () => {
    const { service, eventEmitter } = makeHarness();
    await service.merge('b1', 'survivor', 'duplicate');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'contact.merged',
      expect.objectContaining({ survivorId: 'survivor', duplicateId: 'duplicate' }),
    );
  });

  it('reports irreversibility up front rather than at revert time', async () => {
    const { service, repository } = makeHarness();
    repository.executeMerge.mockResolvedValue({
      merge: { id: 'merge-2' },
      survivor: client(),
      execution: {
        counts: { analytics_events: 50_000 },
        moved: {},
        reversible: false,
        unrecorded: ['analytics_events'],
      },
    } as never);

    const result = await service.merge('b1', 'survivor', 'duplicate');
    expect(result.reversible).toBe(false);
  });

  it('refuses a self-merge before touching the database', async () => {
    const { service, repository } = makeHarness();
    await expect(service.merge('b1', 'survivor', 'survivor')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.executeMerge).not.toHaveBeenCalled();
  });
});

describe('ContactMergeService.revert', () => {
  it('restores the rows the merge moved', async () => {
    const { service, repository } = makeHarness();
    const result = await service.revert('b1', 'merge-1', { revertedBy: 'tm-1' });

    expect(result.restored).toEqual({ conversations: 3 });
    expect(repository.revertMerge).toHaveBeenCalledWith('b1', expect.anything(), 'tm-1');
  });

  it('404s for a merge belonging to another tenant', async () => {
    const { service, repository } = makeHarness();
    repository.findMerge.mockResolvedValue(null);

    await expect(service.revert('b1', 'merge-x')).rejects.toThrow(NotFoundException);
  });

  it('refuses to revert twice', async () => {
    const { service, repository } = makeHarness();
    repository.findMerge.mockResolvedValue({
      id: 'merge-1',
      reverted_at: new Date(),
      snapshot: { reversible: true },
    } as never);

    await expect(service.revert('b1', 'merge-1')).rejects.toThrow(BadRequestException);
  });

  it('refuses outright rather than half-restoring an irreversible merge', async () => {
    // A partial revert leaves the contact restored with only some of its
    // history, which looks like data loss and is harder to reason about than
    // the merge it was undoing.
    const { service, repository } = makeHarness();
    repository.findMerge.mockResolvedValue({
      id: 'merge-1',
      reverted_at: null,
      snapshot: { reversible: false, unrecorded: ['analytics_events'] },
    } as never);

    await expect(service.revert('b1', 'merge-1')).rejects.toThrow(/cannot be reverted/);
    expect(repository.revertMerge).not.toHaveBeenCalled();
  });

  it('audits the revert', async () => {
    const { service, audit } = makeHarness();
    await service.revert('b1', 'merge-1', { revertedBy: 'tm-1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'contact_merge_revert' }),
    );
  });
});

describe('ContactMergeService.findDuplicates', () => {
  it('returns nothing when the tenant has fewer than two contacts', async () => {
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([client()]);

    expect(await service.findDuplicates('b1')).toEqual([]);
  });

  it('suggests a pair that shares a phone number', async () => {
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([
      client({ id: 'a', created_at: new Date('2025-01-01') }),
      client({ id: 'b', email: null, name: null, created_at: new Date('2026-01-01') }),
    ]);

    const pairs = await service.findDuplicates('b1');

    expect(pairs).toHaveLength(1);
    // The older record survives.
    expect(pairs[0]!.survivorId).toBe('a');
    expect(pairs[0]!.duplicateId).toBe('b');
  });

  it('never suggests a pair below the threshold', async () => {
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([
      client({ id: 'a', name: 'Asha', email: 'a@x.in', phone: '+911111111111' }),
      client({ id: 'b', name: 'Rahul', email: 'r@y.in', phone: '+912222222222' }),
    ]);

    expect(await service.findDuplicates('b1')).toEqual([]);
  });

  it('honours a caller-supplied threshold', async () => {
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([
      client({ id: 'a', name: 'Rahul Sharma', email: null, phone: null }),
      client({ id: 'b', name: 'Rahul Sharma', email: null, phone: null }),
    ]);

    expect(await service.findDuplicates('b1')).toEqual([]);
    expect(await service.findDuplicates('b1', { threshold: 0.2 })).toHaveLength(1);
  });

  it('sorts the strongest matches first', async () => {
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([
      client({ id: 'a', created_at: new Date('2024-01-01') }),
      // Exact phone + exact name + exact email — the strongest possible pair.
      client({ id: 'b', created_at: new Date('2025-06-01') }),
      // Phone only.
      client({ id: 'c', name: null, email: null, created_at: new Date('2025-07-01') }),
    ]);

    const pairs = await service.findDuplicates('b1');

    expect(pairs.length).toBeGreaterThan(1);
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i - 1]!.score).toBeGreaterThanOrEqual(pairs[i]!.score);
    }
  });

  it('never merges anything', async () => {
    // Detection suggests; only an explicit call naming both ids acts.
    const { service, repository } = makeHarness();
    repository.findDedupCandidates.mockResolvedValue([
      client({ id: 'a' }),
      client({ id: 'b', created_at: new Date('2026-01-01') }),
    ]);

    await service.findDuplicates('b1');
    expect(repository.executeMerge).not.toHaveBeenCalled();
  });
});
