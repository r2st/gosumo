import { MessageType, FileUploadType } from '@prisma/client';

/**
 * Message module constants.
 *
 * Centralizes the polymorphic-content → column-type mappings and tunable
 * limits used across the service and repository.
 */

/** Maximum number of rows returned by a text search. */
export const MAX_SEARCH_RESULTS = 50;

/** Default page size for conversation message retrieval. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Sender types for the `sender_type` column live in
// `conversation/conversation.constants.ts` (SENDER_TYPE / SenderType). A
// verbatim second copy used to sit here and was read by nothing.

/**
 * Map a polymorphic content `type` discriminant (see `MessageContent` in
 * @gosumo/shared) to the coarse `MessageType` enum stored on the column.
 *
 * Contact cards have no dedicated DB enum value, so they are classified as
 * INTERACTIVE while the full structured payload is preserved in `content`.
 */
const CONTENT_TYPE_TO_MESSAGE_TYPE: Record<string, MessageType> = {
  TEXT: MessageType.TEXT,
  IMAGE: MessageType.IMAGE,
  VIDEO: MessageType.VIDEO,
  AUDIO: MessageType.AUDIO,
  DOCUMENT: MessageType.DOCUMENT,
  LOCATION: MessageType.LOCATION,
  STICKER: MessageType.STICKER,
  INTERACTIVE: MessageType.INTERACTIVE,
  TEMPLATE: MessageType.TEMPLATE,
  PAYMENT_LINK: MessageType.PAYMENT_LINK,
  REACTION: MessageType.REACTION,
  CONTACT: MessageType.INTERACTIVE,
  CONTACT_CARD: MessageType.INTERACTIVE,
  SYSTEM: MessageType.SYSTEM,
};

/**
 * Resolve the `MessageType` for a content payload. Unknown/absent types fall
 * back to TEXT so the message is still persisted and searchable.
 */
export function resolveMessageType(content: unknown): MessageType {
  if (content && typeof content === 'object' && 'type' in content) {
    const raw = String((content as { type: unknown }).type).toUpperCase();
    return CONTENT_TYPE_TO_MESSAGE_TYPE[raw] ?? MessageType.TEXT;
  }
  return MessageType.TEXT;
}

/** Content types that participate in full-text search (text-bearing only). */
export const SEARCHABLE_MESSAGE_TYPES: MessageType[] = [MessageType.TEXT];

/** Map a media content type to the FileUploadType for `file_uploads`. */
const MEDIA_TYPE_TO_UPLOAD_TYPE: Record<string, FileUploadType> = {
  IMAGE: FileUploadType.IMAGE,
  VIDEO: FileUploadType.VIDEO,
  AUDIO: FileUploadType.AUDIO,
  DOCUMENT: FileUploadType.DOCUMENT,
  STICKER: FileUploadType.IMAGE,
};

export function resolveFileUploadType(contentType: string): FileUploadType {
  return MEDIA_TYPE_TO_UPLOAD_TYPE[contentType.toUpperCase()] ?? FileUploadType.OTHER;
}

/** Content types that carry a media attachment. */
export const MEDIA_CONTENT_TYPES = [
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'STICKER',
];

// ─────────────────────────────────────────────
// Media attachment bounds
//
// `file_uploads` describes a file GoSumo has already stored; the columns are
// metadata a caller supplies, not bytes the API receives. That does not make
// them free-form. Two of these bounds are the database's, and exceeding either
// is a 500 rather than a validation error: `mime_type` is VARCHAR(100), and
// `storage_key` is indexed, so an unbounded value fails the insert. The rest
// are the ones a caller should be told about at the boundary.
// ─────────────────────────────────────────────

/**
 * Largest file size a caller may declare. 100 MiB is WhatsApp's document
 * ceiling — the largest thing any channel here delivers — and it also keeps
 * the value inside `size_bytes`' int4 column, which a declared exabyte would
 * overflow into a Prisma error.
 */
export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

/** `mime_type` is VARCHAR(100). */
export const MAX_MIME_TYPE_LENGTH = 100;

/** Generous for a real CDN URL, bounded for a `@db.Text` column. */
export const MAX_CDN_URL_LENGTH = 2048;

/** Pixel dimensions are int4 and describe an image, not an arbitrary integer. */
export const MAX_MEDIA_DIMENSION = 100_000;

/** `type/subtype`, RFC 6838 token characters only. No parameters, no spaces. */
const MIME_TYPE_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,62}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,62}$/;

/**
 * The top-level MIME type each media kind must declare.
 *
 * The point is not tidiness. `is_public` exists on these rows, so an IMAGE
 * carrying `text/html` is a stored-XSS setup waiting for whatever eventually
 * serves the object; declaring `image/*` for something the sender knows is
 * HTML is the whole trick. DOCUMENT and OTHER are deliberately unconstrained —
 * a document legitimately spans PDF, Office, and archive types.
 */
const REQUIRED_MIME_PREFIX: Record<string, string> = {
  IMAGE: 'image/',
  STICKER: 'image/',
  VIDEO: 'video/',
  AUDIO: 'audio/',
};

/**
 * Coerce a caller-declared media integer (size, width, height) into the range
 * its int4 column can hold.
 *
 * Clamping rather than rejecting is right only on the inbound-message path,
 * where these values are descriptive metadata on a message that has already
 * been stored — a declared size of 1e15 should not cost the attachment, and it
 * certainly should not reach Postgres and become a 500. The request DTO
 * rejects the same values outright, because there the caller is present to be
 * told.
 */
export function clampMediaInt(value: unknown, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

/** Whether `mimeType` is a well-formed `type/subtype` within the column bound. */
export function isWellFormedMimeType(mimeType: unknown): mimeType is string {
  return (
    typeof mimeType === 'string' &&
    mimeType.length <= MAX_MIME_TYPE_LENGTH &&
    MIME_TYPE_SHAPE.test(mimeType)
  );
}

/**
 * Whether `mimeType` is well-formed *and* consistent with the declared media
 * `type`. An unknown or unconstrained type only has to be well-formed.
 */
export function isMimeTypeConsistent(type: string, mimeType: unknown): boolean {
  if (!isWellFormedMimeType(mimeType)) return false;
  const required = REQUIRED_MIME_PREFIX[type.toUpperCase()];
  return !required || mimeType.toLowerCase().startsWith(required);
}

/** Upper bound on the number of replies returned for a single message. */
export const MAX_REPLIES_PER_MESSAGE = 100;

/** Template category reserved for short canned "quick reply" snippets. */
export const QUICK_REPLY_CATEGORY = 'QUICK_REPLY';
