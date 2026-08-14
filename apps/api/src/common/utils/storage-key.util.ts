/**
 * What may be stored as a GoSumo object storage key.
 *
 * `file_uploads.storage_key` is written from two places — the
 * `POST /messages/:id/media` body and the media payload on an inbound message
 * — and in both the value arrives from outside. It is a *pointer*: nothing
 * dereferences it today, but the moment something does (a presigned-URL
 * signer, a thumbnailer, a retention sweep that deletes by key) it decides
 * which bytes get read, served, or removed. A key stored now is a key
 * dereferenced later, so it has to be safe at write time — after the fact
 * there is no way to tell a poisoned row from a legitimate one.
 *
 * Four shapes are rejected:
 *
 *  - **Traversal** (`a/../../b`, or any `..` segment). S3 keys are opaque
 *    strings, so `..` means nothing to S3 — but every local mirror, cache
 *    directory, and `path.join` on the way to one treats it as a parent hop.
 *  - **Absolute paths and schemes** (`/etc/passwd`, `https://…`, `s3://…`,
 *    `file://…`). The column is documented as an object key and never a URL;
 *    a fetcher handed `http://169.254.169.254/…` is an SSRF, and one handed an
 *    absolute path escapes the prefix entirely.
 *  - **Control characters, NUL, and backslashes.** A NUL truncates the key in
 *    any C-backed consumer, so `safe.jpg\0../../secret` passes a suffix check
 *    and opens something else. Backslashes are separators on the way through
 *    Windows tooling.
 *  - **Over-long keys.** S3 caps a key at 1024 bytes, and the column is
 *    indexed — a btree entry over ~2704 bytes fails the insert outright, so an
 *    unbounded key is a 500 as well as a storage error.
 *
 * Note what is deliberately *not* enforced: a per-tenant key prefix. No such
 * convention exists in the schema or the data yet, and inventing one here
 * would reject every key already written. Tenant isolation for these rows
 * comes from `business_id` on the row, as everywhere else.
 */

/** S3's own limit on a key, in bytes. */
export const MAX_STORAGE_KEY_BYTES = 1024;

/** A `..` path segment anywhere in the key. */
const TRAVERSAL_SEGMENT = /(^|\/)\.\.(\/|$)/;

/** `scheme://` at the start — any scheme, not just http. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** C0 controls, DEL, and the Windows separator. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BACKSLASH = /[\u0000-\u001F\u007F\\]/;

/**
 * Whether `key` is safe to store as an object key.
 *
 * Deliberately a predicate rather than a sanitizer: rewriting a caller's key
 * into something "safe" stores a pointer to bytes they did not name.
 */
export function isSafeStorageKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 0) return false;
  if (Buffer.byteLength(key, 'utf8') > MAX_STORAGE_KEY_BYTES) return false;
  if (key.startsWith('/')) return false;
  if (URL_SCHEME.test(key)) return false;
  if (TRAVERSAL_SEGMENT.test(key)) return false;
  if (CONTROL_OR_BACKSLASH.test(key)) return false;
  return true;
}

/**
 * Whether `filename` is safe to store as a display/download name.
 *
 * Separate from the key on purpose: a filename is what a `Content-Disposition`
 * header or a local `writeFile` will use, so it must be a single path
 * component — `../../.ssh/authorized_keys` is a plausible-looking "original
 * filename" from a crafted client, and it must not survive to a download.
 */
export function isSafeFilename(filename: unknown): filename is string {
  if (typeof filename !== 'string') return false;
  if (filename.length === 0) return false;
  if (filename === '.' || filename === '..') return false;
  if (filename.includes('/')) return false;
  if (CONTROL_OR_BACKSLASH.test(filename)) return false;
  return true;
}
