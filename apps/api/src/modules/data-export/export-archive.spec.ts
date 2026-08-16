import { gunzipSync } from 'node:zlib';
import { DataExportArchiveFormat } from '@gosumo/database';
import {
  archiveFilename,
  inflateArchive,
  serializeArchive,
  sha256,
} from './export-archive.util';
import type { DataExportBundle } from './data-export.service';

/** A minimal but structurally complete bundle. */
function bundle(overrides: Partial<DataExportBundle> = {}): DataExportBundle {
  return {
    formatVersion: '1.0',
    generatedAt: '2026-08-15T10:30:00.000Z',
    businessId: 'biz-1',
    subject: {
      clientId: 'client-9',
      name: 'Asha',
      email: 'asha@example.com',
      phone: '+919876543210',
      firstSeenAt: new Date('2024-01-01T00:00:00.000Z'),
    },
    disclosure: {
      withheldFields: ['payments.gateway_signature'],
      aiDecisionsExcluded: 4,
      truncated: true,
      notes: ['One or more sections reached their export limit.'],
    },
    sections: {
      messages: { included: 2, total: 9, truncated: true },
      orders: { included: 1, total: 1, truncated: false },
    },
    data: {
      profile: { name: 'Asha', phone: '+919876543210' },
      channelIdentities: [{ channel: 'WHATSAPP', externalId: '919876543210' }],
      conversations: [{ id: 'conv-1', channel: 'WHATSAPP' }],
      messages: [
        { id: 'msg-1', textContent: 'hello' },
        { id: 'msg-2', textContent: 'is my order shipped?' },
      ],
      orders: [{ id: 'order-1', total: 129900 }],
      payments: [],
      bookings: [],
      notifications: [],
      consents: [],
    },
    ...overrides,
  };
}

describe('export-archive.util', () => {
  describe('serializeArchive — JSON', () => {
    it('round-trips the whole bundle through gzip', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.JSON);
      const restored = JSON.parse(gunzipSync(archive.compressed).toString('utf8'));

      expect(restored.subject.clientId).toBe('client-9');
      expect(restored.data.messages).toHaveLength(2);
      expect(restored.disclosure.aiDecisionsExcluded).toBe(4);
    });

    it('reports the uncompressed size, not the compressed one', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.JSON);

      // The operator is told how big the export *is*, not how well it zipped.
      expect(archive.byteSize).toBeGreaterThan(archive.compressed.byteLength);
      expect(archive.byteSize).toBe(
        Buffer.from(JSON.stringify(bundle(), null, 2), 'utf8').byteLength,
      );
    });

    it('checksums the uncompressed bytes so a recipient can verify transfer', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.JSON);
      const raw = gunzipSync(archive.compressed);

      expect(archive.checksum).toBe(sha256(raw));
      expect(archive.checksum).toHaveLength(64);
    });
  });

  describe('serializeArchive — NDJSON', () => {
    it('emits one JSON object per line, each naming its section', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.NDJSON);
      const lines = gunzipSync(archive.compressed)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      expect(lines[0].section).toBe('meta');
      for (const line of lines) {
        expect(typeof line.section).toBe('string');
        expect(line).toHaveProperty('record');
      }
    });

    it('carries the same disclosure metadata as JSON', () => {
      // The format is a delivery choice, never a disclosure one: an operator
      // must not be able to drop the truncation caveat by picking NDJSON.
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.NDJSON);
      const meta = JSON.parse(
        gunzipSync(archive.compressed).toString('utf8').split('\n')[0]!,
      ).record;

      expect(meta.disclosure.truncated).toBe(true);
      expect(meta.disclosure.withheldFields).toEqual(['payments.gateway_signature']);
      expect(meta.disclosure.aiDecisionsExcluded).toBe(4);
      expect(meta.sections.messages.total).toBe(9);
    });

    it('emits the profile as a single record, not one line per field', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.NDJSON);
      const profileLines = gunzipSync(archive.compressed)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.section === 'profile');

      expect(profileLines).toHaveLength(1);
      expect(profileLines[0].record.name).toBe('Asha');
    });

    it('emits every record of every collection', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.NDJSON);
      const lines = gunzipSync(archive.compressed)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

      const bySection = lines.reduce<Record<string, number>>((acc, l) => {
        acc[l.section] = (acc[l.section] ?? 0) + 1;
        return acc;
      }, {});

      expect(bySection['messages']).toBe(2);
      expect(bySection['orders']).toBe(1);
      expect(bySection['conversations']).toBe(1);
      expect(bySection['payments']).toBeUndefined(); // empty collection emits nothing
    });

    it('ends with a newline so the last record is not mistaken for a truncated write', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.NDJSON);
      expect(gunzipSync(archive.compressed).toString('utf8').endsWith('\n')).toBe(true);
    });
  });

  describe('archiveFilename', () => {
    it('names the client id and generation date, and nothing personal', () => {
      const name = archiveFilename(
        'client-9',
        '2026-08-15T10:30:00.000Z',
        DataExportArchiveFormat.JSON,
      );

      expect(name).toBe('gosumo-export-client-9-2026-08-15.json');
      // A filename lands in a downloads folder and on screen-shares.
      expect(name).not.toContain('Asha');
      expect(name).not.toContain('9876543210');
    });

    it('accepts a Date as readily as an ISO string', () => {
      expect(
        archiveFilename(
          'c1',
          new Date('2026-08-15T10:30:00.000Z'),
          DataExportArchiveFormat.NDJSON,
        ),
      ).toBe('gosumo-export-c1-2026-08-15.ndjson');
    });
  });

  describe('inflateArchive', () => {
    it('reverses serializeArchive', () => {
      const archive = serializeArchive(bundle(), DataExportArchiveFormat.JSON);
      const text = inflateArchive(archive.compressed).toString('utf8');

      expect(JSON.parse(text).businessId).toBe('biz-1');
      expect(sha256(inflateArchive(archive.compressed))).toBe(archive.checksum);
    });
  });
});
