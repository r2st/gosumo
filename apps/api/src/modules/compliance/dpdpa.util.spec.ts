/**
 * DPDPA primitives unit tests (business plan §21).
 *
 * These are pure, side-effect-free functions, so every branch is covered
 * deterministically. They are the foundation the erasure/retention/notice
 * services build on, so their guarantees matter:
 *  - anonymization is irreversible and stable (same input → same token)
 *  - the notice is short, once-only, and carries the STOP opt-out
 *  - retention math uses a UTC month-shifted cutoff
 */

import {
  ANONYMIZED_NAME,
  DEFAULT_RETENTION_MONTHS,
  anonymizeEmail,
  anonymizePhone,
  buildFirstContactNotice,
  isPastRetention,
  retentionCutoff,
  withFirstContactNotice,
} from './dpdpa.util';

describe('constants', () => {
  it('anonymized name placeholder is "Anonymized"', () => {
    expect(ANONYMIZED_NAME).toBe('Anonymized');
  });

  it('default retention window is 24 months (plan §21)', () => {
    expect(DEFAULT_RETENTION_MONTHS).toBe(24);
  });
});

describe('buildFirstContactNotice', () => {
  it('names the brokerage and carries the STOP opt-out', () => {
    const notice = buildFirstContactNotice('Acme Realty');
    expect(notice).toContain('Acme Realty');
    expect(notice).toContain('STOP');
    expect(notice).toContain('opt out');
  });

  it('falls back to a generic name when blank/whitespace', () => {
    expect(buildFirstContactNotice('   ')).toContain('this brokerage');
    expect(buildFirstContactNotice('')).toContain('this brokerage');
  });

  it('falls back when the name is nullish (defensive)', () => {
    expect(buildFirstContactNotice(null as unknown as string)).toContain('this brokerage');
    expect(buildFirstContactNotice(undefined as unknown as string)).toContain('this brokerage');
  });

  it('trims surrounding whitespace from the name', () => {
    expect(buildFirstContactNotice('  Baner Homes  ')).toContain('Baner Homes to assist');
  });
});

describe('withFirstContactNotice', () => {
  it('prepends the notice to a normal message', () => {
    const out = withFirstContactNotice('Hi there!', 'Acme Realty', false);
    expect(out).toBe(`${buildFirstContactNotice('Acme Realty')}\n\nHi there!`);
  });

  it('returns the message untouched once the notice was already sent', () => {
    expect(withFirstContactNotice('Hi there!', 'Acme Realty', true)).toBe('Hi there!');
  });

  it('returns null when the message is null (never fabricates a send)', () => {
    expect(withFirstContactNotice(null, 'Acme Realty', false)).toBeNull();
  });

  it('returns just the notice when the message is empty/whitespace', () => {
    expect(withFirstContactNotice('   ', 'Acme Realty', false)).toBe(
      buildFirstContactNotice('Acme Realty'),
    );
  });

  it('trims the message body before appending', () => {
    const out = withFirstContactNotice('  padded  ', 'Acme Realty', false);
    expect(out?.endsWith('padded')).toBe(true);
    expect(out).not.toContain('  padded  ');
  });
});

describe('anonymizePhone', () => {
  it('produces a stable anon: token for the same input', () => {
    const a = anonymizePhone('+919876543210');
    const b = anonymizePhone('+919876543210');
    expect(a).toBe(b);
    expect(a).toMatch(/^anon:[0-9a-f]{16}$/);
  });

  it('is not reversible — the digits do not survive', () => {
    expect(anonymizePhone('+919876543210')).not.toContain('9876543210');
  });

  it('gives different tokens to different numbers', () => {
    expect(anonymizePhone('+919876543210')).not.toBe(anonymizePhone('+919000000000'));
  });

  it('returns a fixed sentinel for empty/nullish input', () => {
    expect(anonymizePhone(null)).toBe('anon:unknown');
    expect(anonymizePhone(undefined)).toBe('anon:unknown');
    expect(anonymizePhone('')).toBe('anon:unknown');
  });
});

describe('anonymizeEmail', () => {
  it('produces a stable, case-insensitive anon token', () => {
    const a = anonymizeEmail('Buyer@Example.com');
    const b = anonymizeEmail('buyer@example.com');
    expect(a).toBe(b);
    expect(a).toMatch(/^anon\+[0-9a-f]{16}@erased\.invalid$/);
  });

  it('does not leak the local-part or domain', () => {
    const token = anonymizeEmail('buyer@example.com');
    expect(token).not.toContain('buyer');
    expect(token).not.toContain('example.com');
  });

  it('returns null for empty/nullish input', () => {
    expect(anonymizeEmail(null)).toBeNull();
    expect(anonymizeEmail(undefined)).toBeNull();
    expect(anonymizeEmail('')).toBeNull();
  });
});

describe('retentionCutoff', () => {
  it('shifts the cutoff back by the retention window (UTC months)', () => {
    const now = new Date('2026-07-03T00:00:00Z');
    expect(retentionCutoff(24, now).toISOString()).toBe('2024-07-03T00:00:00.000Z');
  });

  it('does not mutate the passed `now`', () => {
    const now = new Date('2026-07-03T00:00:00Z');
    retentionCutoff(24, now);
    expect(now.toISOString()).toBe('2026-07-03T00:00:00.000Z');
  });
});

describe('isPastRetention', () => {
  const now = new Date('2026-07-03T00:00:00Z');

  it('uses last_activity_at when present', () => {
    // 25 months ago → past a 24-month window
    const stale = new Date('2024-06-01T00:00:00Z');
    expect(isPastRetention(stale, new Date('2020-01-01Z'), 24, now)).toBe(true);
  });

  it('is false for a lead active within the window', () => {
    const recent = new Date('2026-01-01T00:00:00Z');
    expect(isPastRetention(recent, new Date('2020-01-01Z'), 24, now)).toBe(false);
  });

  it('falls back to created_at when last_activity_at is null', () => {
    const oldCreate = new Date('2023-01-01T00:00:00Z');
    expect(isPastRetention(null, oldCreate, 24, now)).toBe(true);

    const newCreate = new Date('2026-06-01T00:00:00Z');
    expect(isPastRetention(null, newCreate, 24, now)).toBe(false);
  });

  it('is false exactly at the cutoff boundary (strictly-less-than)', () => {
    const atCutoff = retentionCutoff(24, now);
    expect(isPastRetention(atCutoff, atCutoff, 24, now)).toBe(false);
  });

  it('is true one millisecond before the cutoff', () => {
    const cutoff = retentionCutoff(24, now);
    const justBefore = new Date(cutoff.getTime() - 1);
    expect(isPastRetention(justBefore, justBefore, 24, now)).toBe(true);
  });
});
