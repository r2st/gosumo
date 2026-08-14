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

/** Template category reserved for short canned "quick reply" snippets. */
export const QUICK_REPLY_CATEGORY = 'QUICK_REPLY';
