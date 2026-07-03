import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, NAV_SECTIONS, NAV_TOP } from './nav-items';

describe('nav-items', () => {
  it('exposes the four realty-first sections in order', () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      'Realty',
      'Commerce',
      'Engagement',
      'Insights',
    ]);
  });

  it('groups the realty surfaces together', () => {
    const realty = NAV_SECTIONS.find((s) => s.label === 'Realty');
    expect(realty?.items.map((i) => i.label)).toEqual([
      'Leads',
      'Inventory',
      'Site Visits',
      'Cadences',
      'Broker Console',
      'Exchange',
      'Approvals',
      'Import',
    ]);
  });

  it('keeps Dashboard as the standalone top entry', () => {
    expect(NAV_TOP.map((i) => i.label)).toEqual(['Dashboard']);
    // Dashboard must not also live inside a section.
    const inSections = NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.href);
    expect(inSections).not.toContain('/dashboard');
  });

  it('flattens NAV_ITEMS to every entry with unique hrefs, top item first', () => {
    expect(NAV_ITEMS[0]?.href).toBe('/dashboard');
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // 1 top + 8 + 3 + 3 + 2 grouped
    expect(NAV_ITEMS).toHaveLength(17);
  });
});
