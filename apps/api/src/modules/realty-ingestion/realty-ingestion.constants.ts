import * as crypto from 'crypto';

/**
 * DLQ source keys for the three `@Public()` lead-ingestion webhooks.
 *
 * These double as the `WebhookDlqService` replayer registry keys, so the string
 * a delivery is captured under is the string that finds the function able to
 * re-run it. They are namespaced away from the channel webhooks, whose sources
 * are bare `ChannelType` values — a realty portal enquiry and a WhatsApp
 * message are different payloads with different replayers, and sharing a key
 * would hand one to the other.
 */
export const REALTY_INGEST_SOURCES = {
  META_LEADGEN: 'REALTY_META_LEADGEN',
  PORTAL_EMAIL: 'REALTY_PORTAL_EMAIL',
  IVR: 'REALTY_IVR',
} as const;

export type RealtyIngestSource =
  (typeof REALTY_INGEST_SOURCES)[keyof typeof REALTY_INGEST_SOURCES];

/** Event types recorded on the dead letter, for the ops list view. */
export const REALTY_INGEST_EVENT_TYPES = {
  [REALTY_INGEST_SOURCES.META_LEADGEN]: 'lead.leadgen',
  [REALTY_INGEST_SOURCES.PORTAL_EMAIL]: 'lead.portal_email',
  [REALTY_INGEST_SOURCES.IVR]: 'lead.ivr_missed_call',
} as const;

/**
 * `webhook_dead_letters` is unique on `(source, external_id)`, so every capture
 * needs an id that is stable for one provider delivery and distinct across
 * different ones. None of these three providers gives us a usable one:
 *
 *   - Meta Leadgen batches several leadgen ids into one POST,
 *   - a portal enquiry arrives as a parsed email with no message id, and
 *   - IVR callbacks carry a caller and a timestamp, not a delivery id.
 *
 * Hashing the body gives both properties for free, and gives the upsert the
 * right meaning as a bonus: the *same* body redelivered lands on the same
 * recovery row rather than stacking a second one beside it.
 *
 * Truncated to 32 hex characters — 128 bits, far past collision relevance at
 * this volume, and comfortably inside the column's 255.
 */
export function ingestDeliveryId(source: RealtyIngestSource, body: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(body ?? null) ?? 'null';
  } catch {
    // A payload with a circular reference cannot be hashed by value. It also
    // cannot have come off the wire as JSON, so this is a programming error
    // rather than a provider one — fall back to something unique so the
    // capture still happens instead of throwing inside a catch block.
    serialized = `unserializable:${process.hrtime.bigint().toString()}`;
  }
  const digest = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 32);
  return `${source.toLowerCase()}:${digest}`;
}
