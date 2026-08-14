import { Prisma, PrismaClient } from '@prisma/client';

import { isUniqueViolation } from './sequential-number.util';

/**
 * The identifiers a `clients` row is unique on within a business —
 * `uq_clients_business_phone` and `uq_clients_business_email`.
 *
 * These two constraints are what makes a person, rather than a channel
 * handle, the unit of identity: the same buyer reaching a business from
 * WhatsApp and then from SMS is one client with two `channel_contacts`, not
 * two clients. Every path that creates a client on first contact has to
 * resolve against them, because the alternative is not a duplicate row — the
 * database refuses the insert outright.
 */
export interface ClientIdentity {
  phone?: string | null;
  email?: string | null;
}

/** The subset of the `clients` delegate identity resolution touches. */
type ClientsDelegate = Pick<PrismaClient['clients'], 'findFirst' | 'create' | 'update'>;

/** Outcome of resolving an identity to a client row. */
export interface ResolvedClient {
  id: string;
  /** True when no existing client held either identifier and one was inserted. */
  created: boolean;
  /** True when the match was a soft-deleted row that had to be brought back. */
  revived: boolean;
}

/**
 * `where` matching whichever client already occupies either of this identity's
 * unique identifiers, or `null` when there is nothing unique to match on.
 *
 * Mirrors the two unique constraints exactly — same columns, same business
 * scope, and deliberately **no** `deleted_at` filter, because the constraints
 * have none either. A soft-deleted row still owns its phone number as far as
 * Postgres is concerned, so a lookup that skipped it would report "free" for a
 * value the very next insert cannot use.
 *
 * Blank strings are ignored: `''` is not an identity, and matching on it would
 * collapse every identifier-less client in a business into one.
 */
export function clientIdentityWhere(
  businessId: string,
  identity: ClientIdentity,
): Prisma.clientsWhereInput | null {
  const or: Prisma.clientsWhereInput[] = [];
  if (identity.phone) or.push({ phone: identity.phone });
  if (identity.email) or.push({ email: identity.email });
  if (or.length === 0) return null;

  return { business_id: businessId, OR: or };
}

/**
 * Find the client already holding this identity's phone or email, reviving it
 * if it was soft-deleted. Returns `null` when the identity is free — or when
 * there is no identifier to match on at all, which is the normal case for
 * Instagram and Web Chat senders whose handle is not a phone or an email.
 *
 * A live match always wins over a soft-deleted one: an identity can be spread
 * across two rows (a deleted contact holding the phone, a live one holding the
 * email), and attaching a live conversation to a tombstone when a real client
 * exists would hide the customer from the dashboard.
 *
 * Reviving is the honest resolution for the remaining case. The only thing in
 * this codebase that soft-deletes a client is `mergeClients`, and a merge now
 * releases the loser's identifiers precisely so its tombstone cannot match
 * here. Anything that still does is a row from before that fix, and the person
 * behind it has just sent a message — leaving them deleted would mean either
 * dropping that message or filing it under a client no operator can see.
 */
export async function claimClientByIdentity(
  clients: ClientsDelegate,
  businessId: string,
  identity: ClientIdentity,
): Promise<{ id: string; revived: boolean } | null> {
  const where = clientIdentityWhere(businessId, identity);
  if (!where) return null;

  const match = await clients.findFirst({
    where,
    select: { id: true, deleted_at: true },
    // `nulls: 'first'` is what prefers a live row to a tombstone.
    orderBy: { deleted_at: { sort: 'asc', nulls: 'first' } },
  });
  if (!match) return null;

  if (match.deleted_at !== null) {
    await clients.update({
      where: { id: match.id, business_id: businessId },
      data: { deleted_at: null },
    });
    return { id: match.id, revived: true };
  }

  return { id: match.id, revived: false };
}

/**
 * Resolve an identity to a client id, creating the client only when nothing
 * already holds its phone or email.
 *
 * The unique-violation retry is not defensive padding: two messages from the
 * same new sender arriving together both see a free identity, and one of them
 * loses the insert. Re-claiming turns that loser into the same reuse path the
 * second message would have taken a moment later, instead of an error the
 * caller has to decide what to do with.
 *
 * @param name Display name for a client that has to be created. Ignored on
 *   reuse — an existing client's name belongs to whoever set it, and the
 *   sender profile a channel reports is usually the weaker of the two.
 */
export async function findOrCreateClientByIdentity(
  clients: ClientsDelegate,
  businessId: string,
  identity: ClientIdentity,
  name?: string | null,
): Promise<ResolvedClient> {
  const claimed = await claimClientByIdentity(clients, businessId, identity);
  if (claimed) return { id: claimed.id, created: false, revived: claimed.revived };

  try {
    const created = await clients.create({
      data: {
        business_id: businessId,
        name: name ?? null,
        phone: identity.phone ?? null,
        email: identity.email ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, created: true, revived: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const raced = await claimClientByIdentity(clients, businessId, identity);
    // A P2002 with nothing to re-claim means the violation was on some other
    // constraint. Surfacing it beats returning a client id that is not there.
    if (!raced) throw err;
    return { id: raced.id, created: false, revived: raced.revived };
  }
}
