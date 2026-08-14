/**
 * Client identity resolution.
 *
 * `clients` is unique on (business, phone) and (business, email), which is what
 * makes a person — rather than a channel handle — the unit of identity. Every
 * first-contact path has to resolve against those two constraints, because a
 * second row for a buyer who already exists is not a duplicate that shows up
 * later in a cleanup report: it is a P2002 that fails the insert on the spot.
 *
 * On the inbound webhook path that failure was invisible and permanent. The
 * throw was swallowed, and the delivery had already been written to
 * `webhook_events`, so the provider's retry was deduped away. A WhatsApp buyer
 * who texted the same business from the same number simply lost the message.
 *
 * So what is pinned here is the resolution itself: which row a phone or an
 * email claims, that a soft-deleted row still holds its identifier as far as
 * Postgres is concerned, that a live match beats a tombstone, and that losing
 * the insert to a concurrent first message ends in reuse rather than an error.
 */

import { Prisma, PrismaClient } from '@prisma/client';

import {
  claimClientByIdentity,
  clientIdentityWhere,
  findOrCreateClientByIdentity,
} from './client-identity.util';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';
const OTHER_CLIENT_ID = '00000000-0000-4000-c000-000000000002';

const PHONE = '+919876543210';
const EMAIL = 'asha@example.invalid';

interface ClientsDouble {
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
}

function makeClients(overrides: Partial<ClientsDouble> = {}): ClientsDouble {
  return {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: CLIENT_ID }),
    update: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/** The double, typed as the delegate the util accepts. */
const asDelegate = (d: ClientsDouble): Pick<PrismaClient['clients'], 'findFirst' | 'create' | 'update'> =>
  d as unknown as Pick<PrismaClient['clients'], 'findFirst' | 'create' | 'update'>;

/** A P2002 as Prisma reports a unique-constraint violation. */
function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
    meta: { target },
  });
}

// ─────────────────────────────────────────────
// clientIdentityWhere
// ─────────────────────────────────────────────

describe('clientIdentityWhere', () => {
  it('matches either identifier, scoped to the business', () => {
    expect(clientIdentityWhere(BUSINESS_ID, { phone: PHONE, email: EMAIL })).toEqual({
      business_id: BUSINESS_ID,
      OR: [{ phone: PHONE }, { email: EMAIL }],
    });
  });

  it('matches on whichever identifier it was given', () => {
    expect(clientIdentityWhere(BUSINESS_ID, { phone: PHONE })).toEqual({
      business_id: BUSINESS_ID,
      OR: [{ phone: PHONE }],
    });
    expect(clientIdentityWhere(BUSINESS_ID, { email: EMAIL })).toEqual({
      business_id: BUSINESS_ID,
      OR: [{ email: EMAIL }],
    });
  });

  it('reports "nothing to match on" for a sender with neither', () => {
    // Instagram and Web Chat senders arrive as an opaque handle. There is no
    // identity to resolve, so every one of them is a distinct client.
    expect(clientIdentityWhere(BUSINESS_ID, {})).toBeNull();
    expect(clientIdentityWhere(BUSINESS_ID, { phone: null, email: null })).toBeNull();
  });

  it('does not treat a blank identifier as an identity', () => {
    // Matching on '' would collapse every identifier-less client in a business
    // into whichever one happened to be stored with an empty string.
    expect(clientIdentityWhere(BUSINESS_ID, { phone: '', email: '' })).toBeNull();
  });

  it('carries no deleted_at filter, because the constraints have none', () => {
    // A soft-deleted row still owns its phone number in Postgres. A lookup that
    // skipped it would report the identity free for a value the very next
    // insert cannot use.
    const where = clientIdentityWhere(BUSINESS_ID, { phone: PHONE });
    expect(where).not.toHaveProperty('deleted_at');
  });
});

// ─────────────────────────────────────────────
// claimClientByIdentity
// ─────────────────────────────────────────────

describe('claimClientByIdentity', () => {
  it('returns the client already holding the phone', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT_ID, deleted_at: null }),
    });

    await expect(
      claimClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).resolves.toEqual({ id: CLIENT_ID, revived: false });
  });

  it('returns null when the identity is free', async () => {
    const clients = makeClients();

    await expect(
      claimClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).resolves.toBeNull();
  });

  it('does not query at all when there is no identifier to match on', async () => {
    const clients = makeClients();

    await expect(
      claimClientByIdentity(asDelegate(clients), BUSINESS_ID, {}),
    ).resolves.toBeNull();
    expect(clients.findFirst).not.toHaveBeenCalled();
  });

  it('prefers a live row to a tombstone', async () => {
    // An identity can straddle two rows — a deleted contact holding the phone,
    // a live one holding the email. Ordering nulls first is what decides it.
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT_ID, deleted_at: null }),
    });

    await claimClientByIdentity(asDelegate(clients), BUSINESS_ID, {
      phone: PHONE,
      email: EMAIL,
    });

    expect(clients.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { deleted_at: { sort: 'asc', nulls: 'first' } },
      }),
    );
  });

  it('revives a soft-deleted match rather than leaving the sender invisible', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT_ID, deleted_at: new Date() }),
    });

    await expect(
      claimClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).resolves.toEqual({ id: CLIENT_ID, revived: true });

    expect(clients.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, business_id: BUSINESS_ID },
      data: { deleted_at: null },
    });
  });

  it('scopes the revival to the business that owns the row', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT_ID, deleted_at: new Date() }),
    });

    await claimClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE });

    expect(clients.update.mock.calls[0]?.[0].where).toEqual({
      id: CLIENT_ID,
      business_id: BUSINESS_ID,
    });
  });

  it('leaves a live match untouched', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: CLIENT_ID, deleted_at: null }),
    });

    await claimClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE });

    expect(clients.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// findOrCreateClientByIdentity
// ─────────────────────────────────────────────

describe('findOrCreateClientByIdentity', () => {
  it('creates when nothing holds the identity', async () => {
    const clients = makeClients();

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }, 'Asha'),
    ).resolves.toEqual({ id: CLIENT_ID, created: true, revived: false });

    expect(clients.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { business_id: BUSINESS_ID, name: 'Asha', phone: PHONE, email: null },
      }),
    );
  });

  it('reuses the client that already holds the phone instead of inserting', async () => {
    // The WhatsApp-then-SMS case: same person, second channel account, no
    // contact row here yet — but the phone is already spoken for.
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: OTHER_CLIENT_ID, deleted_at: null }),
    });

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }, 'Asha'),
    ).resolves.toEqual({ id: OTHER_CLIENT_ID, created: false, revived: false });

    expect(clients.create).not.toHaveBeenCalled();
  });

  it('reuses on a matching email as readily as on a phone', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: OTHER_CLIENT_ID, deleted_at: null }),
    });

    const result = await findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, {
      email: EMAIL,
    });

    expect(result.id).toBe(OTHER_CLIENT_ID);
    expect(result.created).toBe(false);
  });

  it('does not rename the client it reused', async () => {
    // An existing name was set by an operator or by an earlier, better source.
    // The sender profile a channel reports is usually the weaker of the two.
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: OTHER_CLIENT_ID, deleted_at: null }),
    });

    await findOrCreateClientByIdentity(
      asDelegate(clients),
      BUSINESS_ID,
      { phone: PHONE },
      'wa_919876543210',
    );

    expect(clients.update).not.toHaveBeenCalled();
  });

  it('always creates for a sender with no phone and no email', async () => {
    // Two Instagram handles are two people until an operator says otherwise.
    const clients = makeClients();

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, {}, 'ig_user'),
    ).resolves.toMatchObject({ created: true });

    expect(clients.findFirst).not.toHaveBeenCalled();
    expect(clients.create).toHaveBeenCalled();
  });

  it('nulls the identity columns it was given nothing for', async () => {
    const clients = makeClients();

    await findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, {}, null);

    expect(clients.create.mock.calls[0]?.[0].data).toEqual({
      business_id: BUSINESS_ID,
      name: null,
      phone: null,
      email: null,
    });
  });

  it('re-claims when a concurrent first message wins the insert', async () => {
    // Two messages from the same new sender arrive together; both see the
    // identity free and one loses. Reuse is where the loser was headed anyway.
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: OTHER_CLIENT_ID, deleted_at: null });
    const clients = makeClients({
      findFirst,
      create: jest.fn().mockRejectedValue(uniqueViolation(['business_id', 'phone'])),
    });

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).resolves.toEqual({ id: OTHER_CLIENT_ID, created: false, revived: false });
  });

  it('reports a revival that only became visible on the retry', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: OTHER_CLIENT_ID, deleted_at: new Date() });
    const clients = makeClients({
      findFirst,
      create: jest.fn().mockRejectedValue(uniqueViolation(['business_id', 'phone'])),
    });

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).resolves.toEqual({ id: OTHER_CLIENT_ID, created: false, revived: true });
  });

  it('rethrows a unique violation it cannot explain', async () => {
    // P2002 with nothing to re-claim means the collision was on some other
    // constraint. Returning a client id that is not there would be worse.
    const clients = makeClients({
      create: jest.fn().mockRejectedValue(uniqueViolation(['some_other_column'])),
    });

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('rethrows an error that is not a unique violation', async () => {
    const clients = makeClients({
      create: jest.fn().mockRejectedValue(new Error('connection reset')),
    });

    await expect(
      findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE }),
    ).rejects.toThrow('connection reset');
  });

  it('does not retry a create it never attempted', async () => {
    const clients = makeClients({
      findFirst: jest.fn().mockResolvedValue({ id: OTHER_CLIENT_ID, deleted_at: null }),
    });

    await findOrCreateClientByIdentity(asDelegate(clients), BUSINESS_ID, { phone: PHONE });

    expect(clients.findFirst).toHaveBeenCalledTimes(1);
  });
});
