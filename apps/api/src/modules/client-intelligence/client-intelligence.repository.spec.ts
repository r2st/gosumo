/**
 * ClientIntelligenceRepository unit tests — Prisma access for `clients` and
 * `channel_contacts`.
 *
 * The interesting behaviour here is not "does it call Prisma" but the shape of
 * the query it builds:
 *   - `listClients` composes three independent optional filters (text search,
 *     channel, churn band) onto one `where`, and the churn band is a numeric
 *     range table that is easy to get subtly wrong;
 *   - `updateClientProfile` and `updateIntelligenceScores` write only the keys
 *     they were given, so an omitted field must not be sent as null;
 *   - `mergeClients` decides which of two rows wins each identity field, sums
 *     the aggregates, and unions the two profiles with the primary on top.
 *
 * PrismaService is mocked; assertions are on the emitted query and the returned
 * shape, never on a database result.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ChannelType, ResourceNotFoundError } from '@gosumo/shared';
import { Prisma } from '@prisma/client';

import { ClientIntelligenceRepository } from './client-intelligence.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { ChurnRiskLevel } from './dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-b000-000000000001';
const OTHER_CLIENT_ID = '00000000-0000-4000-b000-000000000002';
const ACCOUNT_ID = '00000000-0000-4000-c000-000000000001';

/** A `Prisma.Decimal` stand-in for read rows. */
const decimal = (n: number) => ({ toNumber: () => n }) as never;

interface PrismaMock {
  clients: Record<
    'findFirst' | 'findFirstOrThrow' | 'findMany' | 'count' | 'create' | 'update',
    jest.Mock
  >;
  channel_contacts: Record<'findFirst' | 'create' | 'update' | 'updateMany', jest.Mock>;
  conversations: Record<'findMany' | 'updateMany', jest.Mock>;
  orders: Record<'findFirst' | 'findMany' | 'updateMany' | 'aggregate', jest.Mock>;
  bookings: Record<'findMany' | 'updateMany', jest.Mock>;
  payments: Record<'findMany' | 'updateMany', jest.Mock>;
  shipping_addresses: Record<'updateMany', jest.Mock>;
  $transaction: jest.Mock;
}

describe('ClientIntelligenceRepository', () => {
  let repository: ClientIntelligenceRepository;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      clients: {
        findFirst: jest.fn(),
        findFirstOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
      },
      channel_contacts: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      conversations: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      orders: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        aggregate: jest.fn(),
      },
      bookings: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      payments: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      shipping_addresses: { updateMany: jest.fn() },
      // Run the callback against the same mock — the repository's transactional
      // work is what these tests are about.
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientIntelligenceRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(ClientIntelligenceRepository);
  });

  // ── findOrCreateClient ───────────────────────

  describe('findOrCreateClient', () => {
    it('returns the existing client and refreshes last_seen_at', async () => {
      const client = { id: CLIENT_ID, channel_contacts: [] };
      prisma.channel_contacts.findFirst.mockResolvedValue({ id: 'cc_1', client });

      const result = await repository.findOrCreateClient(
        BUSINESS_ID,
        '919876543210',
        ChannelType.WHATSAPP,
        ACCOUNT_ID,
        {},
      );

      expect(result).toBe(client);
      expect(prisma.clients.create).not.toHaveBeenCalled();
      expect(prisma.channel_contacts.update).toHaveBeenCalledWith({
        where: { id: 'cc_1', business_id: BUSINESS_ID },
        data: { last_seen_at: expect.any(Date) },
      });
    });

    it('creates client + contact when no contact exists and the identity is free', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockResolvedValue({ id: CLIENT_ID });
      prisma.clients.findFirstOrThrow.mockResolvedValue({ id: CLIENT_ID, channel_contacts: [] });

      await repository.findOrCreateClient(
        BUSINESS_ID,
        'ig_handle',
        ChannelType.INSTAGRAM,
        ACCOUNT_ID,
        { name: 'Asha', phone: '+919876543210', email: 'asha@example.invalid' },
      );

      expect(prisma.clients.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: BUSINESS_ID,
            name: 'Asha',
            phone: '+919876543210',
            email: 'asha@example.invalid',
          }),
        }),
      );
      expect(prisma.channel_contacts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          client_id: CLIENT_ID,
          channel: ChannelType.INSTAGRAM,
          external_id: 'ig_handle',
          display_name: 'Asha',
        }),
      });
      // Read-back is scoped, not a bare primary-key lookup.
      expect(prisma.clients.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CLIENT_ID, business_id: BUSINESS_ID } }),
      );
    });

    it('nulls the identity columns it was given nothing for', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockResolvedValue({ id: CLIENT_ID });
      prisma.clients.findFirstOrThrow.mockResolvedValue({ id: CLIENT_ID });

      await repository.findOrCreateClient(
        BUSINESS_ID,
        'anon',
        ChannelType.WEB_CHAT,
        ACCOUNT_ID,
        {},
      );

      const created = prisma.clients.create.mock.calls[0]![0].data;
      expect(created).toMatchObject({ name: null, email: null, phone: null });
      expect(prisma.channel_contacts.create.mock.calls[0]![0].data.display_name).toBeNull();
    });

    // ── Arriving on a second channel ──────────
    //
    // "One client per (businessId, externalId, channelType)" was the contract;
    // the code inserted a client whenever the contact lookup missed. For a
    // buyer who already existed on another channel that did not make a second
    // row — `clients` is unique on (business, phone) and (business, email), so
    // it raised P2002 and failed the call outright.

    it('attaches to the client already holding the phone', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, deleted_at: null });
      prisma.clients.findFirstOrThrow.mockResolvedValue({ id: CLIENT_ID, channel_contacts: [] });

      await repository.findOrCreateClient(BUSINESS_ID, '919876543210', ChannelType.SMS, ACCOUNT_ID, {
        name: 'Asha',
        phone: '+919876543210',
      });

      expect(prisma.clients.create).not.toHaveBeenCalled();
      expect(prisma.channel_contacts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          client_id: CLIENT_ID,
          channel: ChannelType.SMS,
          external_id: '919876543210',
        }),
      });
    });

    it('returns the matched client rather than erroring on the constraint', async () => {
      const existing = { id: CLIENT_ID, channel_contacts: [] };
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, deleted_at: null });
      prisma.clients.findFirstOrThrow.mockResolvedValue(existing);

      await expect(
        repository.findOrCreateClient(BUSINESS_ID, 'buyer@example.invalid', ChannelType.EMAIL, ACCOUNT_ID, {
          email: 'buyer@example.invalid',
        }),
      ).resolves.toBe(existing);
    });

    it('tolerates a concurrent first message having written the contact', async () => {
      // `[channel_account_id, external_id]` is unique. Two messages from the
      // same new sender race, and the row the loser wanted is already there.
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockResolvedValue({ id: CLIENT_ID });
      prisma.channel_contacts.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.0.0',
          meta: { target: ['channel_account_id', 'external_id'] },
        }),
      );
      prisma.clients.findFirstOrThrow.mockResolvedValue({ id: CLIENT_ID });

      await expect(
        repository.findOrCreateClient(BUSINESS_ID, 'ig_handle', ChannelType.INSTAGRAM, ACCOUNT_ID, {}),
      ).resolves.toMatchObject({ id: CLIENT_ID });
    });

    it('does not swallow a contact insert that failed for another reason', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);
      prisma.clients.findFirst.mockResolvedValue(null);
      prisma.clients.create.mockResolvedValue({ id: CLIENT_ID });
      prisma.channel_contacts.create.mockRejectedValue(new Error('connection reset'));

      await expect(
        repository.findOrCreateClient(BUSINESS_ID, 'ig_handle', ChannelType.INSTAGRAM, ACCOUNT_ID, {}),
      ).rejects.toThrow('connection reset');
    });
  });

  // ── Single-client reads ──────────────────────

  describe('getClientById', () => {
    it('scopes to the business and excludes soft-deleted rows', async () => {
      prisma.clients.findFirst.mockResolvedValue(null);

      await expect(repository.getClientById(BUSINESS_ID, CLIENT_ID)).resolves.toBeNull();
      expect(prisma.clients.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLIENT_ID, business_id: BUSINESS_ID, deleted_at: null },
        }),
      );
    });
  });

  describe('getClientByExternalId', () => {
    it('returns the client behind the contact', async () => {
      const client = { id: CLIENT_ID, deleted_at: null };
      prisma.channel_contacts.findFirst.mockResolvedValue({ client });

      await expect(
        repository.getClientByExternalId(BUSINESS_ID, '919876543210', ChannelType.WHATSAPP),
      ).resolves.toBe(client);
    });

    it('returns null when no contact matches', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);

      await expect(
        repository.getClientByExternalId(BUSINESS_ID, 'nobody', ChannelType.SMS),
      ).resolves.toBeNull();
    });

    it('returns null when the contact points at a soft-deleted client', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue({
        client: { id: CLIENT_ID, deleted_at: new Date() },
      });

      await expect(
        repository.getClientByExternalId(BUSINESS_ID, '919876543210', ChannelType.WHATSAPP),
      ).resolves.toBeNull();
    });
  });

  // ── updateClientProfile ──────────────────────

  describe('updateClientProfile', () => {
    it('throws when the client is not in this business', async () => {
      prisma.clients.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateClientProfile(BUSINESS_ID, CLIENT_ID, { name: 'x' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).message).toBe('Client not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Client',
        resourceId: CLIENT_ID,
        businessId: BUSINESS_ID,
      });
      expect(prisma.clients.update).not.toHaveBeenCalled();
    });

    it('writes only the fields it was given', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, profile: {} });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateClientProfile(BUSINESS_ID, CLIENT_ID, { name: 'Asha' });

      expect(prisma.clients.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CLIENT_ID, business_id: BUSINESS_ID },
          data: { name: 'Asha' },
        }),
      );
    });

    it('maps every camelCase field onto its column', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, profile: {} });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });
      const when = new Date('2026-08-01T00:00:00Z');

      await repository.updateClientProfile(BUSINESS_ID, CLIENT_ID, {
        name: 'Asha',
        email: 'asha@example.invalid',
        phone: '+919876543210',
        avatarUrl: 'https://cdn.example.invalid/a.png',
        ltvScore: 4200,
        churnRisk: 0.42,
        engagementScore: 71,
        totalOrders: 3,
        totalSpent: 125000,
        lastInteractionAt: when,
        scoresUpdatedAt: when,
      });

      expect(prisma.clients.update.mock.calls[0]![0].data).toEqual({
        name: 'Asha',
        email: 'asha@example.invalid',
        phone: '+919876543210',
        avatar_url: 'https://cdn.example.invalid/a.png',
        ltv_score: 4200,
        churn_risk: 0.42,
        engagement_score: 71,
        total_orders: 3,
        total_spent: 125000,
        last_interaction_at: when,
        scores_updated_at: when,
      });
    });

    it('merges the profile patch over the stored profile', async () => {
      prisma.clients.findFirst.mockResolvedValue({
        id: CLIENT_ID,
        profile: { language: 'hi', city: 'Pune' },
      });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateClientProfile(BUSINESS_ID, CLIENT_ID, {
        profile: { city: 'Mumbai', budget: 8000000 },
      });

      expect(prisma.clients.update.mock.calls[0]![0].data.profile).toEqual({
        language: 'hi',
        city: 'Mumbai',
        budget: 8000000,
      });
    });

    it('treats a null stored profile as empty rather than throwing', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, profile: null });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateClientProfile(BUSINESS_ID, CLIENT_ID, { profile: { a: 1 } });

      expect(prisma.clients.update.mock.calls[0]![0].data.profile).toEqual({ a: 1 });
    });

    it('sends an explicit null when a field is set to null', async () => {
      // `!== undefined` is the guard, so clearing a field must survive it.
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID, profile: {} });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateClientProfile(BUSINESS_ID, CLIENT_ID, {
        email: null as unknown as string,
      });

      expect(prisma.clients.update.mock.calls[0]![0].data).toEqual({ email: null });
    });
  });

  // ── listClients ──────────────────────────────

  describe('listClients', () => {
    /** Returns the `where` the list query was built with. */
    async function whereFor(filters: Parameters<typeof repository.listClients>[1]) {
      await repository.listClients(BUSINESS_ID, filters);
      return prisma.clients.findMany.mock.calls[0]![0].where;
    }

    it('defaults to page 1 / limit 20 and reports the page count', async () => {
      prisma.clients.count.mockResolvedValue(45);

      const result = await repository.listClients(BUSINESS_ID, {});

      expect(prisma.clients.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result).toMatchObject({ page: 1, limit: 20, total: 45, totalPages: 3 });
    });

    it('turns page/limit into a skip', async () => {
      await repository.listClients(BUSINESS_ID, { page: 3, limit: 10 });

      expect(prisma.clients.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('applies no optional predicate when no filter is given', async () => {
      const where = await whereFor({});

      expect(where).toEqual({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('searches name and email case-insensitively, phone exactly', async () => {
      const where = await whereFor({ search: 'asha' });

      expect(where.OR).toEqual([
        { name: { contains: 'asha', mode: 'insensitive' } },
        { email: { contains: 'asha', mode: 'insensitive' } },
        { phone: { contains: 'asha' } },
      ]);
    });

    it('ignores an empty search string', async () => {
      const where = await whereFor({ search: '' });

      expect(where.OR).toBeUndefined();
    });

    it('filters by channel through the contact relation', async () => {
      const where = await whereFor({ channelType: ChannelType.WHATSAPP });

      expect(where.channel_contacts).toEqual({ some: { channel: ChannelType.WHATSAPP } });
    });

    it.each([
      [ChurnRiskLevel.LOW, 0, 0.3],
      [ChurnRiskLevel.MEDIUM, 0.31, 0.6],
      [ChurnRiskLevel.HIGH, 0.61, 0.8],
      [ChurnRiskLevel.CRITICAL, 0.81, 1.0],
    ])('maps churn band %s to [%s, %s]', async (level, min, max) => {
      const where = await whereFor({ churnRisk: level });

      expect(where.churn_risk).toEqual({ gte: min, lte: max });
    });

    it('combines all three filters onto one where', async () => {
      const where = await whereFor({
        search: 'asha',
        channelType: ChannelType.SMS,
        churnRisk: ChurnRiskLevel.HIGH,
      });

      expect(where).toMatchObject({
        business_id: BUSINESS_ID,
        deleted_at: null,
        OR: expect.any(Array),
        channel_contacts: { some: { channel: ChannelType.SMS } },
        churn_risk: { gte: 0.61, lte: 0.8 },
      });
    });

    it('counts with the same where as the page query', async () => {
      await repository.listClients(BUSINESS_ID, { search: 'asha' });

      expect(prisma.clients.count.mock.calls[0]![0].where).toEqual(
        prisma.clients.findMany.mock.calls[0]![0].where,
      );
    });
  });

  // ── mergeClients ─────────────────────────────

  describe('mergeClients', () => {
    function primaryAndSecondary(
      primary: Record<string, unknown> = {},
      secondary: Record<string, unknown> = {},
    ) {
      const base = {
        total_orders: 0,
        total_spent: decimal(0),
        last_interaction_at: null,
        profile: {},
        name: null,
        email: null,
        phone: null,
        avatar_url: null,
      };
      prisma.clients.findFirst
        .mockResolvedValueOnce({ id: CLIENT_ID, ...base, ...primary })
        .mockResolvedValueOnce({ id: OTHER_CLIENT_ID, ...base, ...secondary });
      prisma.clients.findFirstOrThrow.mockResolvedValue({ id: CLIENT_ID });
    }

    /**
     * The `data` of the update that writes the merged primary — the *second*
     * of the two. Retiring the secondary has to come first, because it is what
     * releases the phone/email the primary is about to inherit.
     */
    const mergedData = () => prisma.clients.update.mock.calls[1]![0].data;

    /** The `data` of the update that retires the secondary. */
    const retiredData = () => prisma.clients.update.mock.calls[0]![0].data;

    it('throws when the primary is not in this business', async () => {
      prisma.clients.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'x' });

      const error = await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID).then(
        () => null,
        (err: unknown) => err,
      );

      // Both sides carry the same message, so `resourceId`/`role` is the only
      // thing that says the *primary* was the missing one.
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Client',
        resourceId: CLIENT_ID,
        businessId: BUSINESS_ID,
        role: 'primary',
      });
      expect(prisma.clients.update).not.toHaveBeenCalled();
    });

    it('throws when the secondary is not in this business', async () => {
      prisma.clients.findFirst
        .mockResolvedValueOnce({ id: CLIENT_ID })
        .mockResolvedValueOnce(null);

      const error = await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Client',
        resourceId: OTHER_CLIENT_ID,
        businessId: BUSINESS_ID,
        role: 'secondary',
      });
      expect(prisma.clients.update).not.toHaveBeenCalled();
    });

    it('repoints every relation from the secondary to the primary', async () => {
      primaryAndSecondary();

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      const moved = { client_id: CLIENT_ID };
      const from = { where: { client_id: OTHER_CLIENT_ID, business_id: BUSINESS_ID } };
      for (const table of [
        prisma.channel_contacts,
        prisma.conversations,
        prisma.orders,
        prisma.bookings,
        prisma.payments,
        prisma.shipping_addresses,
      ]) {
        expect(table.updateMany).toHaveBeenCalledWith({ ...from, data: moved });
      }
    });

    it('sums the aggregates across both rows', async () => {
      primaryAndSecondary(
        { total_orders: 3, total_spent: decimal(120000) },
        { total_orders: 2, total_spent: decimal(45000) },
      );

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData()).toMatchObject({ total_orders: 5, total_spent: 165000 });
    });

    it('keeps the newer of the two last-interaction timestamps', async () => {
      const older = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-08-01T00:00:00Z');
      primaryAndSecondary({ last_interaction_at: older }, { last_interaction_at: newer });

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData().last_interaction_at).toBe(newer);
    });

    it('falls back to null when neither row has been seen', async () => {
      primaryAndSecondary();

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData().last_interaction_at).toBeNull();
    });

    it('takes the secondary timestamp when the primary has none', async () => {
      const seen = new Date('2026-05-05T00:00:00Z');
      primaryAndSecondary({}, { last_interaction_at: seen });

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData().last_interaction_at).toBe(seen);
    });

    it('fills identity gaps from the secondary but never overwrites the primary', async () => {
      primaryAndSecondary(
        { name: 'Asha', email: null, phone: null, avatar_url: null },
        {
          name: 'A. Sharma',
          email: 'asha@example.invalid',
          phone: '+919876543210',
          avatar_url: 'https://cdn.example.invalid/a.png',
        },
      );

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData()).toMatchObject({
        name: 'Asha',
        email: 'asha@example.invalid',
        phone: '+919876543210',
        avatar_url: 'https://cdn.example.invalid/a.png',
      });
    });

    it('unions the profiles with the primary winning conflicts', async () => {
      primaryAndSecondary(
        { profile: { city: 'Pune', language: 'mr' } },
        { profile: { city: 'Mumbai', budget: 8000000 } },
      );

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData().profile).toEqual({
        city: 'Pune',
        language: 'mr',
        budget: 8000000,
      });
    });

    it('treats null profiles on either side as empty', async () => {
      primaryAndSecondary({ profile: null }, { profile: null });

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData().profile).toEqual({});
    });

    it('soft-deletes the secondary within the business scope', async () => {
      primaryAndSecondary();

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(prisma.clients.update).toHaveBeenNthCalledWith(1, {
        where: { id: OTHER_CLIENT_ID, business_id: BUSINESS_ID },
        data: { deleted_at: expect.any(Date), phone: null, email: null },
      });
    });

    // ── Releasing the loser's identity ──────────
    //
    // `uq_clients_business_phone` / `uq_clients_business_email` do not exclude
    // soft-deleted rows. A tombstone that keeps its phone number means the
    // primary can never inherit it — and the merge that was supposed to
    // collapse a duplicate identity fails on the duplicate identity.

    it('retires the secondary before handing its identity to the primary', async () => {
      primaryAndSecondary(
        { phone: null, email: 'asha@example.invalid' },
        { phone: '+919876543210', email: null },
      );

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      // Order is the whole fix: reversed, the primary update asks Postgres for
      // two live rows on +919876543210 and the transaction rolls back.
      const [first, second] = prisma.clients.update.mock.calls;
      expect(first![0].where.id).toBe(OTHER_CLIENT_ID);
      expect(second![0].where.id).toBe(CLIENT_ID);
      expect(second![0].data.phone).toBe('+919876543210');
    });

    it('clears the identity columns on the retired row, not just deleted_at', async () => {
      primaryAndSecondary({}, { phone: '+919876543210', email: 'asha@example.invalid' });

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      // Also what stops a later inbound message on that number from claiming —
      // and reviving — the loser instead of reaching the surviving client.
      expect(retiredData()).toMatchObject({ phone: null, email: null });
    });

    it('leaves the primary its own identity when both rows carry one', async () => {
      primaryAndSecondary(
        { phone: '+919999999999', email: 'primary@example.invalid' },
        { phone: '+919876543210', email: 'secondary@example.invalid' },
      );

      await repository.mergeClients(BUSINESS_ID, CLIENT_ID, OTHER_CLIENT_ID);

      expect(mergedData()).toMatchObject({
        phone: '+919999999999',
        email: 'primary@example.invalid',
      });
    });
  });

  // ── updateIntelligenceScores ─────────────────

  describe('updateIntelligenceScores', () => {
    it('throws when the client is not in this business', async () => {
      prisma.clients.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateIntelligenceScores(BUSINESS_ID, CLIENT_ID, { ltvScore: 1 })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Client',
        resourceId: CLIENT_ID,
        businessId: BUSINESS_ID,
      });
    });

    it('always stamps scores_updated_at, even with nothing to write', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateIntelligenceScores(BUSINESS_ID, CLIENT_ID, {});

      expect(prisma.clients.update.mock.calls[0]![0].data).toEqual({
        scores_updated_at: expect.any(Date),
      });
    });

    it('writes each provided score onto its column', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateIntelligenceScores(BUSINESS_ID, CLIENT_ID, {
        churnRisk: 0.7,
        ltvScore: 5000,
        engagementScore: 62,
      });

      expect(prisma.clients.update.mock.calls[0]![0].data).toMatchObject({
        churn_risk: 0.7,
        ltv_score: 5000,
        engagement_score: 62,
      });
    });

    it('leaves out the scores it was not given', async () => {
      prisma.clients.findFirst.mockResolvedValue({ id: CLIENT_ID });
      prisma.clients.update.mockResolvedValue({ id: CLIENT_ID });

      await repository.updateIntelligenceScores(BUSINESS_ID, CLIENT_ID, { churnRisk: 0 });

      const data = prisma.clients.update.mock.calls[0]![0].data;
      // 0 is a meaningful churn score — the guard is `!== undefined`, not truthiness.
      expect(data.churn_risk).toBe(0);
      expect(data).not.toHaveProperty('ltv_score');
      expect(data).not.toHaveProperty('engagement_score');
    });
  });

  // ── Channel contacts ─────────────────────────

  describe('channel contacts', () => {
    it('creates a contact, nulling the optional display fields', async () => {
      prisma.channel_contacts.create.mockResolvedValue({ id: 'cc_1' });

      await repository.createChannelContact({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
        channelAccountId: ACCOUNT_ID,
        channel: ChannelType.WHATSAPP,
        externalId: '919876543210',
      });

      expect(prisma.channel_contacts.create.mock.calls[0]![0].data).toMatchObject({
        display_name: null,
        profile_pic_url: null,
      });
    });

    it('passes the optional display fields through when present', async () => {
      prisma.channel_contacts.create.mockResolvedValue({ id: 'cc_1' });

      await repository.createChannelContact({
        businessId: BUSINESS_ID,
        clientId: CLIENT_ID,
        channelAccountId: ACCOUNT_ID,
        channel: ChannelType.INSTAGRAM,
        externalId: 'ig_handle',
        displayName: 'Asha',
        profilePicUrl: 'https://cdn.example.invalid/a.png',
      });

      expect(prisma.channel_contacts.create.mock.calls[0]![0].data).toMatchObject({
        display_name: 'Asha',
        profile_pic_url: 'https://cdn.example.invalid/a.png',
      });
    });

    it('finds a contact by account + external id within the business', async () => {
      prisma.channel_contacts.findFirst.mockResolvedValue(null);

      await repository.findChannelContact(BUSINESS_ID, ACCOUNT_ID, '919876543210');

      expect(prisma.channel_contacts.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          channel_account_id: ACCOUNT_ID,
          external_id: '919876543210',
        },
      });
    });
  });

  // ── Aggregates ───────────────────────────────

  describe('getClientOrderAggregates', () => {
    it('returns the summed revenue and order count', async () => {
      prisma.orders.aggregate.mockResolvedValue({
        _sum: { total: decimal(97500) },
        _count: { id: 4 },
      });

      await expect(
        repository.getClientOrderAggregates(BUSINESS_ID, CLIENT_ID),
      ).resolves.toEqual({ totalRevenue: 97500, orderCount: 4 });
    });

    it('reads a null sum (no matching orders) as zero revenue', async () => {
      prisma.orders.aggregate.mockResolvedValue({ _sum: { total: null }, _count: { id: 0 } });

      await expect(
        repository.getClientOrderAggregates(BUSINESS_ID, CLIENT_ID),
      ).resolves.toEqual({ totalRevenue: 0, orderCount: 0 });
    });

    it('counts only orders that reached a revenue-bearing status', async () => {
      prisma.orders.aggregate.mockResolvedValue({ _sum: { total: null }, _count: { id: 0 } });

      await repository.getClientOrderAggregates(BUSINESS_ID, CLIENT_ID);

      expect(prisma.orders.aggregate.mock.calls[0]![0].where).toMatchObject({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
        status: { in: ['DELIVERED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED'] },
        deleted_at: null,
      });
    });
  });

  describe('getClientRFMData', () => {
    it('throws when the client is not in this business', async () => {
      prisma.clients.findFirst.mockResolvedValue(null);

      const error = await repository.getClientRFMData(BUSINESS_ID, CLIENT_ID).then(
        () => null,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Client',
        resourceId: CLIENT_ID,
        businessId: BUSINESS_ID,
      });
    });

    it('reports the latest order date alongside the client aggregates', async () => {
      const seen = new Date('2026-08-01T00:00:00Z');
      const placed = new Date('2026-07-20T00:00:00Z');
      prisma.clients.findFirst.mockResolvedValue({
        last_interaction_at: seen,
        total_orders: 2,
        total_spent: decimal(66000),
        first_seen_at: new Date('2026-01-01T00:00:00Z'),
      });
      prisma.orders.findFirst.mockResolvedValue({ placed_at: placed });

      await expect(repository.getClientRFMData(BUSINESS_ID, CLIENT_ID)).resolves.toMatchObject({
        lastInteractionAt: seen,
        lastOrderAt: placed,
        orderCount: 2,
        totalSpent: 66000,
      });
    });

    it('reports a null last-order date for a client who never ordered', async () => {
      prisma.clients.findFirst.mockResolvedValue({
        last_interaction_at: null,
        total_orders: 0,
        total_spent: decimal(0),
        first_seen_at: new Date(0),
      });
      prisma.orders.findFirst.mockResolvedValue(null);

      await expect(repository.getClientRFMData(BUSINESS_ID, CLIENT_ID)).resolves.toMatchObject({
        lastOrderAt: null,
      });
    });
  });

  // ── Timeline ─────────────────────────────────

  describe('getClientTimelineData', () => {
    it('caps each source at the limit and scopes all four to the client', async () => {
      await repository.getClientTimelineData(BUSINESS_ID, CLIENT_ID, 15);

      for (const table of [prisma.conversations, prisma.orders, prisma.bookings]) {
        expect(table.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { business_id: BUSINESS_ID, client_id: CLIENT_ID, deleted_at: null },
            take: 15,
          }),
        );
      }
    });

    it('does not filter payments by deleted_at — the table has no such column', async () => {
      await repository.getClientTimelineData(BUSINESS_ID, CLIENT_ID, 15);

      expect(prisma.payments.findMany.mock.calls[0]![0].where).toEqual({
        business_id: BUSINESS_ID,
        client_id: CLIENT_ID,
      });
    });
  });
});
