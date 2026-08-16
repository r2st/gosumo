/**
 * Bounds and redaction policy for the customer data export.
 *
 * The export answers a data-subject access request: everything the business
 * holds about one customer, in one response. That makes it simultaneously the
 * most useful endpoint for a compliance officer and the most dangerous one in
 * the API — a single call is a bulk disclosure of one person's entire
 * relationship with the business, assembled from eight tables.
 *
 * Two consequences run through this file. Every collection is **capped**,
 * because a five-year WhatsApp thread is tens of thousands of messages and
 * nothing else in the API returns an unbounded set. And a handful of fields
 * are **withheld**, because "everything held about the customer" and
 * "everything on rows that mention the customer" are not the same set.
 */

/**
 * Messages returned per export, newest first.
 *
 * The largest collection by an order of magnitude and the only one that grows
 * without a ceiling of its own. 5,000 is roughly a decade of an active
 * WhatsApp relationship and lands around 2–4 MB of JSON — large, deliverable,
 * and far short of what would put the API process under memory pressure
 * assembling it.
 *
 * Newest first because a truncated export must lose the least useful half. An
 * access request is nearly always about something recent, and the oldest
 * messages are the ones most likely to have been anonymized by the retention
 * sweep anyway.
 */
export const MAX_EXPORT_MESSAGES = 5_000;

/** Conversations returned per export, most recently active first. */
export const MAX_EXPORT_CONVERSATIONS = 500;

/**
 * Cap applied to each commerce collection (orders, payments, bookings,
 * notifications, consent records, channel identities).
 *
 * One number rather than six, because none of them is close to it in practice
 * and a per-table figure would be six numbers nobody could justify
 * individually. If a customer really has more than a thousand orders, the
 * truncation flag says so and the summary endpoint gives the true count.
 */
export const MAX_EXPORT_RECORDS_PER_SECTION = 1_000;

/**
 * Fields present on the source rows that the export deliberately withholds.
 *
 * Documented here rather than only in code because a withheld field is a
 * decision somebody may need to defend to a regulator, and "we forgot" and "we
 * decided" look identical in a JSON response. The bundle carries this list so
 * the recipient can see what was left out and ask for it specifically.
 *
 *  - **Gateway secrets and raw provider bodies.** `payments.gateway_signature`
 *    is a credential; `payments.gateway_response` is Razorpay's or Stripe's
 *    own payload, which carries account identifiers and internal trace ids
 *    belonging to *us*, not to the customer. Neither is the data subject's
 *    personal data, and both have leaked out of this API before through
 *    200-body responses.
 *  - **Internal staff notes.** `conversations.metadata.internalNote` and
 *    `orders.internal_note` are what the team wrote to each other *about* this
 *    person. They are within the subject's access right in most readings, and
 *    they are also the single most likely thing in this bundle to cause harm
 *    if a business forwards the export without reading it. Withholding them by
 *    default puts that disclosure behind a deliberate act — the business can
 *    always produce them — rather than making it the accident.
 *
 * AI decisions are excluded for a different reason and are not listed as a
 * withheld *field*: they are the business's inferences about the customer
 * rather than data the customer supplied, and the reasoning text quotes
 * internal policy verbatim. The bundle reports how many exist so their absence
 * is visible rather than silent.
 */
export const WITHHELD_FIELDS: readonly string[] = [
  'payments.gateway_signature',
  'payments.gateway_response',
  'conversations.metadata.internalNote',
  'orders.internal_note',
];

/** Schema version of the bundle, so a consumer can tell two shapes apart. */
export const EXPORT_FORMAT_VERSION = '1.0';
