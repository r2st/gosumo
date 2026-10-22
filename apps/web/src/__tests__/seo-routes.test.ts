import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';

describe('sitemap', () => {
  const urls = sitemap().map((e) => e.url);

  it('lists every public tool page', () => {
    for (const slug of [
      'response-time-calculator',
      'ticket-volume-forecaster',
      'csat-calculator',
      'sla-calculator',
      'survey-builder',
      'ticket-template-generator',
    ]) {
      expect(urls).toContain(`https://desk.doaide.com/tools/${slug}`);
    }
  });

  it('has no duplicate URLs', () => {
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('never lists a dashboard route', () => {
    expect(urls.some((u) => /\/(dashboard|settings|conversations)/.test(u))).toBe(false);
  });
});

describe('robots', () => {
  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;

  it('points crawlers at the sitemap', () => {
    expect(r.sitemap).toBe('https://desk.doaide.com/sitemap.xml');
  });

  it('keeps authenticated areas out of the index', () => {
    expect(rule.disallow).toEqual(expect.arrayContaining(['/dashboard', '/settings', '/api/']));
  });
});
