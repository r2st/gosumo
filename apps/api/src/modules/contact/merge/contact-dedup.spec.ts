import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { clients } from '@prisma/client';
import {
  chooseSurvivor,
  normalizeName,
  normalizePhone,
  scoreDuplicate,
  sharesSubscriberNumber,
} from './contact-dedup.util';
import {
  DUPLICATE_SUGGEST_THRESHOLD,
  MERGE_NON_RELOCATED_TABLES,
  MERGE_RELOCATION_TABLES,
} from './contact-merge.constants';

function contact(overrides: Partial<clients> = {}): Pick<
  clients,
  'id' | 'name' | 'email' | 'phone' | 'created_at'
> {
  return {
    id: 'c1',
    name: 'Asha Iyer',
    email: 'asha@example.in',
    phone: '+919876543210',
    created_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as Pick<clients, 'id' | 'name' | 'email' | 'phone' | 'created_at'>;
}

describe('normalizePhone', () => {
  it('reduces a number to its digits', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('919876543210');
  });

  it('rejects something too short to be a phone number', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('sharesSubscriberNumber', () => {
  it('matches the same number with and without a country code', () => {
    // One row from a webchat form, one from WhatsApp, which always delivers
    // the full international form.
    expect(sharesSubscriberNumber('9876543210', '919876543210')).toBe(true);
  });

  it('does not match two different numbers', () => {
    expect(sharesSubscriberNumber('9876543210', '9876543211')).toBe(false);
  });

  it('refuses to compare numbers too short to be conclusive', () => {
    expect(sharesSubscriberNumber('543210', '919876543210')).toBe(false);
  });
});

describe('normalizeName', () => {
  it('collapses case, punctuation and spacing', () => {
    expect(normalizeName('  Dr.  Asha   Iyer ')).toBe('dr asha iyer');
  });

  it('keeps non-Latin scripts', () => {
    expect(normalizeName('आशा')).toBe('आशा');
  });

  it('returns null for an empty name', () => {
    expect(normalizeName('  ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});

describe('scoreDuplicate', () => {
  it('scores an exact phone match highly', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a', name: null, email: null }) },
      { client: contact({ id: 'b', name: null, email: null }) },
    );

    expect(result.score).toBeGreaterThanOrEqual(DUPLICATE_SUGGEST_THRESHOLD);
    expect(result.signals.map((s) => s.code)).toContain('phone-exact');
  });

  it('catches the same number written two ways', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a', phone: '9876543210', name: null, email: null }) },
      { client: contact({ id: 'b', phone: '+919876543210', name: null, email: null }) },
    );

    expect(result.signals.map((s) => s.code)).toContain('phone-suffix');
  });

  it('does not suggest a pair on a matching name alone', () => {
    // "Sharma" is not evidence. A name-only pair must never reach the threshold.
    const result = scoreDuplicate(
      { client: contact({ id: 'a', name: 'Rahul Sharma', email: null, phone: null }) },
      { client: contact({ id: 'b', name: 'Rahul Sharma', email: null, phone: null }) },
    );

    expect(result.score).toBeLessThan(DUPLICATE_SUGGEST_THRESHOLD);
  });

  it('does not suggest a pair on a shared email local-part alone', () => {
    // info@shopA and info@shopB are two businesses.
    const result = scoreDuplicate(
      { client: contact({ id: 'a', email: 'info@shopa.in', name: null, phone: null }) },
      { client: contact({ id: 'b', email: 'info@shopb.in', name: null, phone: null }) },
    );

    expect(result.score).toBeLessThan(DUPLICATE_SUGGEST_THRESHOLD);
  });

  it('accumulates agreeing signals', () => {
    // A shared phone is common in an Indian household; a shared phone and the
    // same name is not.
    const nameOnly = scoreDuplicate(
      { client: contact({ id: 'a', email: null, phone: null }) },
      { client: contact({ id: 'b', email: null, phone: null }) },
    );
    const both = scoreDuplicate(
      { client: contact({ id: 'a', email: null }) },
      { client: contact({ id: 'b', email: null }) },
    );

    expect(both.score).toBeGreaterThan(nameOnly.score);
  });

  it('treats a shared channel identity as near-decisive', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a', name: null, email: null, phone: null }), externalIds: ['wa-1'] },
      { client: contact({ id: 'b', name: null, email: null, phone: null }), externalIds: ['wa-1'] },
    );

    expect(result.signals.map((s) => s.code)).toContain('channel-identity');
  });

  it('scores two unrelated contacts at zero', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a', name: 'Asha', email: 'a@x.in', phone: '+911111111111' }) },
      { client: contact({ id: 'b', name: 'Rahul', email: 'r@y.in', phone: '+912222222222' }) },
    );

    expect(result.score).toBe(0);
    expect(result.reason).toBe('No matching identifiers');
  });

  it('ignores a field that is missing on one side', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a', phone: null }) },
      { client: contact({ id: 'b' }) },
    );

    expect(result.signals.map((s) => s.code)).not.toContain('phone-exact');
  });

  it('never exceeds 1', () => {
    const result = scoreDuplicate(
      { client: contact({ id: 'a' }), externalIds: ['wa-1'] },
      { client: contact({ id: 'b' }), externalIds: ['wa-1'] },
    );

    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe('chooseSurvivor', () => {
  it('keeps the older record', () => {
    // It is the id that prior receipts, exports and other systems reference.
    const older = { client: contact({ id: 'old', created_at: new Date('2024-01-01') }) };
    const newer = { client: contact({ id: 'new', created_at: new Date('2026-01-01') }) };

    expect(chooseSurvivor(newer, older).client.id).toBe('old');
    expect(chooseSurvivor(older, newer).client.id).toBe('old');
  });

  it('breaks an exact age tie on completeness', () => {
    const at = new Date('2025-01-01');
    const sparse = { client: contact({ id: 'sparse', created_at: at, email: null, phone: null }) };
    const full = { client: contact({ id: 'full', created_at: at }) };

    expect(chooseSurvivor(sparse, full).client.id).toBe('full');
  });
});

describe('MERGE_RELOCATION_TABLES', () => {
  /**
   * The list drives the merge. A table that gains a `client_id` and is not
   * added here leaves rows pointing at a retired contact after a merge —
   * silently, and only visible to the customer whose order vanished. This
   * reads the schema so that omission fails here instead.
   */
  it('classifies every tenant table carrying a client_id', () => {
    const schema = readFileSync(
      join(__dirname, '../../../../../../packages/database/prisma/schema.prisma'),
      'utf8',
    );

    const withClientId = new Set<string>();
    let model: string | null = null;
    for (const line of schema.split('\n')) {
      const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
      if (modelMatch) {
        model = modelMatch[1]!;
        continue;
      }
      if (line.startsWith('}')) {
        model = null;
        continue;
      }
      if (model && /^\s*client_id\s+String\??\s+@db\.Uuid/.test(line)) {
        withClientId.add(model);
      }
    }

    // `clients` itself is the merge's subject, not a relocation target.
    withClientId.delete('clients');

    // Relocated or consciously excluded — either is a decision. Unclassified is
    // not: those rows end up pointing at a retired contact with nobody having
    // chosen that.
    const classified = new Set<string>([
      ...MERGE_RELOCATION_TABLES,
      ...MERGE_NON_RELOCATED_TABLES,
    ]);
    const unclassified = [...withClientId].filter((t) => !classified.has(t));

    expect(unclassified).toEqual([]);
  });

  it('lists no table that does not exist', () => {
    const schema = readFileSync(
      join(__dirname, '../../../../../../packages/database/prisma/schema.prisma'),
      'utf8',
    );
    for (const table of MERGE_RELOCATION_TABLES) {
      expect(schema).toContain(`model ${table} {`);
    }
  });

  it('handles notification_preferences last, since it is the one with a unique key', () => {
    expect(MERGE_RELOCATION_TABLES[MERGE_RELOCATION_TABLES.length - 1]).toBe(
      'notification_preferences',
    );
  });
});
