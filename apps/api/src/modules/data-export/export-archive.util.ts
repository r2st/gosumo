import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DataExportArchiveFormat } from '@gosumo/database';
import type { DataExportBundle } from './data-export.service';

/**
 * Serialization for a subject-access archive.
 *
 * Pure functions, no injectable and no I/O: the archive is built inside a queue
 * worker and verified inside a test, and neither wants a Nest container to
 * decide how a bundle turns into bytes.
 */

/** A serialized archive plus everything needed to describe it without reading it. */
export interface SerializedArchive {
  /** gzip of the serialized document — what gets stored and shipped. */
  compressed: Buffer;
  /** Length of the *uncompressed* document, which is what the operator sees. */
  byteSize: number;
  /** SHA-256 of the uncompressed document, so a recipient can verify transfer. */
  checksum: string;
  filename: string;
  contentType: string;
}

/**
 * Serialize a bundle to the requested format and gzip it.
 *
 * NDJSON exists beside JSON because the two formats fail differently at size.
 * A 4 MB JSON document has to be parsed whole before any of it can be read,
 * which is exactly the operation a recipient's tooling refuses on the export
 * that matters — the decade-long account. NDJSON is one `{section, record}`
 * object per line, so it streams into a spreadsheet, `jq`, or a Python loop
 * without ever holding the export in memory.
 *
 * The bundle's metadata is not dropped in the NDJSON case: it becomes the
 * first line, as a `meta` record. An archive whose caveats about truncation
 * and withheld fields were only present in one of the two formats would make
 * the format choice a disclosure decision, which it must not be.
 */
export function serializeArchive(
  bundle: DataExportBundle,
  format: DataExportArchiveFormat,
): SerializedArchive {
  const text =
    format === DataExportArchiveFormat.NDJSON ? toNdjson(bundle) : toJson(bundle);
  const raw = Buffer.from(text, 'utf8');

  return {
    compressed: gzipSync(raw),
    byteSize: raw.byteLength,
    checksum: sha256(raw),
    filename: archiveFilename(bundle.subject.clientId, bundle.generatedAt, format),
    contentType:
      format === DataExportArchiveFormat.NDJSON
        ? 'application/x-ndjson'
        : 'application/json',
  };
}

/** Inflate a stored archive back to its serialized text. */
export function inflateArchive(compressed: Buffer): Buffer {
  return gunzipSync(compressed);
}

/** SHA-256, lower-case hex. Used for both the checksum and the token hash. */
export function sha256(input: Buffer | string): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/**
 * Filename offered to the operator's browser.
 *
 * Carries the subject's client id and the generation date rather than a name,
 * because the file lands in a downloads folder alongside other people's
 * exports and "export.json" three times over is how the wrong one gets sent to
 * the wrong data subject. The client id is deliberate: it is the one identifier
 * that is stable, unique, and not itself sensitive to have in a filename — a
 * name or phone number in the filename leaks the subject to anyone who sees the
 * file listing or a screen-share.
 */
export function archiveFilename(
  clientId: string,
  generatedAt: Date | string,
  format: DataExportArchiveFormat,
): string {
  const iso = generatedAt instanceof Date ? generatedAt.toISOString() : generatedAt;
  const ext = format === DataExportArchiveFormat.NDJSON ? 'ndjson' : 'json';
  return `gosumo-export-${clientId}-${iso.slice(0, 10)}.${ext}`;
}

function toJson(bundle: DataExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * One JSON object per line. The first is the metadata record; every subsequent
 * line is `{ section, record }`.
 *
 * `profile` is a single object rather than a collection, so it is emitted as
 * one record rather than being spread — a consumer filtering `section ===
 * "profile"` should get one row, not one row per profile field.
 */
function toNdjson(bundle: DataExportBundle): string {
  const lines: string[] = [
    JSON.stringify({
      section: 'meta',
      record: {
        formatVersion: bundle.formatVersion,
        generatedAt: bundle.generatedAt,
        businessId: bundle.businessId,
        subject: bundle.subject,
        disclosure: bundle.disclosure,
        sections: bundle.sections,
      },
    }),
  ];

  for (const [section, value] of Object.entries(bundle.data)) {
    if (Array.isArray(value)) {
      for (const record of value) {
        lines.push(JSON.stringify({ section, record }));
      }
    } else {
      lines.push(JSON.stringify({ section, record: value }));
    }
  }

  // Trailing newline: a line-oriented format without one makes the last record
  // indistinguishable from a truncated write to every tool that reads it.
  return `${lines.join('\n')}\n`;
}
