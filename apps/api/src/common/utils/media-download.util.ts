/**
 * Bounds and checks on binary bodies fetched from somewhere else.
 *
 * `fetchWithTimeout` already stops a transfer that *stalls*. It does nothing
 * about one that streams happily and never ends, or one that is simply enormous:
 * `response.arrayBuffer()` will keep allocating right up to the point the
 * process dies. That matters here because the URL is not always ours to choose
 * — the transcription path fetches whatever address it was handed, and the
 * WhatsApp path fetches whatever address Meta's metadata call named — and the
 * API shares a memory ceiling with everything else on the box.
 *
 * Two checks, because either alone is defeated by an ordinary case:
 *
 *  - `content-length`, when present, is refused *before* a byte moves. Cheap,
 *    and the honest-server case is the common one.
 *  - the body is then read chunk by chunk against a running total, because a
 *    chunked response has no `content-length` at all and a hostile one can
 *    simply lie.
 */

import { ExternalServiceError } from '@gosumo/shared';

/**
 * Ceiling for one media download, in bytes.
 *
 * 25 MB is the upload limit of the OpenAI-compatible `/audio/transcriptions`
 * endpoints this feeds, so anything above it could not have been transcribed
 * anyway — the request would have been spent downloading a file the provider
 * was always going to reject. WhatsApp's own audio cap (16 MB) sits under it.
 */
export const MAX_MEDIA_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Content types a media download may legitimately have.
 *
 * `application/octet-stream` is here because plenty of CDNs serve audio under
 * it. What the list excludes is the point: an HTML login page, a JSON error
 * body, a cloud metadata document — the things a URL comes back as when it is
 * not the audio file someone claimed it was.
 */
export const AUDIO_CONTENT_TYPE_PREFIXES = ['audio/', 'video/', 'application/octet-stream'];

/**
 * Content types a *visual* channel attachment may legitimately have.
 *
 * Identical in spirit to {@link AUDIO_CONTENT_TYPE_PREFIXES}, plus `image/`.
 * The audio list is deliberately not reused for channel media: an Instagram or
 * Messenger attachment is most often a photo, and checking it against a list
 * that omits `image/` would reject every working image download while catching
 * nothing extra.
 */
export const VISUAL_MEDIA_CONTENT_TYPE_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'application/octet-stream',
];

/** A body that exceeded its ceiling. Not retryable — it will be just as big next time. */
export class MediaTooLargeError extends ExternalServiceError {
  constructor(service: string, bytes: number, maxBytes: number) {
    super(service, `media is ${bytes} bytes, over the ${maxBytes}-byte limit`, {
      status: 413,
      retryable: false,
      context: { bytes, maxBytes },
    });
  }
}

/** A body that was not the kind of thing the caller asked for. */
export class UnexpectedContentTypeError extends ExternalServiceError {
  constructor(service: string, contentType: string | null, expected: readonly string[]) {
    super(
      service,
      `unexpected content-type ${contentType ?? '(none)'}; expected one of ${expected.join(', ')}`,
      { status: 415, retryable: false, context: { contentType, expected } },
    );
  }
}

/**
 * Read a response body into a Buffer, refusing anything over `maxBytes`.
 *
 * A body-less response (204, or a HEAD) yields an empty buffer rather than
 * throwing — "nothing came back" is the caller's judgement to make, not this
 * function's.
 */
export async function readBodyWithLimit(
  response: Response,
  options: { service: string; maxBytes?: number },
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_MEDIA_DOWNLOAD_BYTES;

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaTooLargeError(options.service, declared, maxBytes);
  }

  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new MediaTooLargeError(options.service, total, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Releases the connection when we bailed out mid-stream. Already-drained
    // streams treat this as a no-op, and a cancel that itself fails must not
    // mask the size error that caused it.
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks, total);
}

/**
 * Refuse a response whose `content-type` is not in `expected`.
 *
 * A missing header is allowed: some origins omit it entirely on binary
 * responses, and rejecting those would break working downloads to catch
 * nothing — the size cap is the backstop that actually bounds the damage.
 */
export function assertContentType(
  service: string,
  contentType: string | null,
  expected: readonly string[] = AUDIO_CONTENT_TYPE_PREFIXES,
): void {
  if (!contentType) return;
  const normalized = contentType.split(';')[0]!.trim().toLowerCase();
  if (!expected.some((prefix) => normalized.startsWith(prefix))) {
    throw new UnexpectedContentTypeError(service, contentType, expected);
  }
}

/**
 * Whether a URL is one the server may go and fetch.
 *
 * `https` only. The alternative is a signed-in user handing the API any address
 * they like and having it fetched from inside the network — `http://localhost:6379`,
 * `http://169.254.169.254/latest/meta-data/`, a `file:` path. Requiring TLS is
 * not a full SSRF defence (it does not stop an internal https host) but it
 * removes every plaintext internal target in one line, and it is what the
 * media-reference contract already claimed to accept.
 */
export function isFetchableMediaUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
