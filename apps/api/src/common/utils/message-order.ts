/**
 * The one order messages are read in.
 *
 * `ORDER BY created_at DESC` is not a total order. `created_at` defaults to
 * Postgres `now()`, which is the *transaction start* timestamp at microsecond
 * resolution, so any two messages whose transactions begin in the same
 * microsecond compare equal — and with nothing to break the tie the database is
 * free to return them in either order, differently on each execution. That is
 * exactly the situation this platform manufactures: inbound messages from
 * WhatsApp, Instagram, SMS and web chat are ingested by BullMQ workers running
 * concurrently, and a customer sending two lines in quick succession is the
 * ordinary case rather than the pathological one.
 *
 * Two things go wrong when the tie is left open, and the second is the worse:
 *
 *  - **Meaning inverts.** "Book me for 2pm" followed by "no wait, make it 3pm"
 *    read in the other order is a different instruction, and the AI acts on
 *    whichever order it was handed.
 *  - **A `LIMIT` silently drops a message.** The context window is
 *    `ORDER BY created_at DESC LIMIT 20`. When the tie straddles the twentieth
 *    row, *which* of the tied rows falls inside the window is arbitrary, so the
 *    AI can be given nineteen messages and a repeat, or a message from before
 *    the one it is missing. Nothing logs a warning; the window is full.
 *
 * The tie-break is `id`, which is a v4 UUID and therefore carries no time
 * information — it cannot recover the true order, and nothing can, because for
 * same-microsecond inserts there is no recorded true order to recover. What it
 * buys is that every reader agrees. Before this existed the dashboard's
 * paginated list tie-broke on `id` and the AI context window did not, so under
 * a tie the human reviewing an escalation and the AI that produced it were
 * looking at different conversations. Consistency is the property worth having;
 * matching `findByConversation`'s existing `(created_at DESC, id DESC)` is why
 * the direction is `desc`.
 *
 * Ordering is by `created_at` — when GoSumo ingested the message — and never by
 * a channel-supplied timestamp. Providers disagree about clocks and about
 * timezones, and a customer's handset clock is not evidence of anything; a
 * skewed provider would otherwise be able to inject a message into the middle
 * of a conversation, or before its start. `messages.sent_at` exists for display
 * and is deliberately not a sort key.
 *
 * Keyset pagination cursors are `(created_at, id)` pairs for the same reason —
 * a cursor over a non-unique sort key can skip or repeat rows across pages.
 */

/** Newest first. The reading order for context windows and previews. */
export const MESSAGE_ORDER_NEWEST_FIRST = [
  { created_at: 'desc' as const },
  { id: 'desc' as const },
];

/** Oldest first — the same total order, read forwards. */
export const MESSAGE_ORDER_OLDEST_FIRST = [
  { created_at: 'asc' as const },
  { id: 'asc' as const },
];

/**
 * ## The true order, where it applies
 *
 * Everything above is what could be recovered from the columns that already
 * existed: an order every reader agrees on, built on a tie-break that carries
 * no information. `messages.sequence` (migration 0040) is the order itself — a
 * per-conversation counter claimed under a row lock at insert time, so it
 * records the order the writes committed in rather than approximating it from a
 * timestamp that cannot tell two of them apart.
 *
 * It is a *separate* pair of constants rather than a change to the two above,
 * because `sequence` only orders messages **within one conversation**. Two
 * messages in different conversations routinely hold the same sequence — every
 * conversation has a message 1 — so on a tenant-wide read, sorting by sequence
 * first would order results by position-in-thread and call it recency. The
 * inbox search would answer "the first message of every conversation" to a
 * query that asked for the newest matches.
 *
 * So: use these when the query is scoped to a single `conversation_id`, and the
 * pair above when it is not. Two rules, and which one applies is visible in the
 * `where` clause of the query using it.
 *
 * The old keys stay on as trailing tie-breaks. They are unreachable while
 * `messages_conversation_id_sequence_key` holds, which is the point — an order
 * that cannot tie does not need a tie-break, and one that inexplicably does
 * should still not be arbitrary.
 *
 * Note for keyset pagination: `findByConversation` cursors on `(created_at,
 * id)` and so still sorts by them. A cursor must agree with its sort key or it
 * skips and repeats rows across pages, and changing the cursor format would
 * break every cursor a client is currently holding. `sequence` would make a
 * better cursor — one integer, unique within the conversation — and that is a
 * migration of the pagination contract, not of the sort.
 */

/** Newest first within one conversation. Requires a `conversation_id` filter. */
export const MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST = [
  { sequence: 'desc' as const },
  { created_at: 'desc' as const },
  { id: 'desc' as const },
];

/** Oldest first within one conversation. Requires a `conversation_id` filter. */
export const MESSAGE_ORDER_IN_CONVERSATION_OLDEST_FIRST = [
  { sequence: 'asc' as const },
  { created_at: 'asc' as const },
  { id: 'asc' as const },
];
