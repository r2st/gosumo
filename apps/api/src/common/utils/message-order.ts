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
