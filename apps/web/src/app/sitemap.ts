import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://desk.doaide.com';
  return [
    { url: base, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/tools`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/tools/response-time-calculator`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/tools/ticket-volume-forecaster`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/tools/csat-calculator`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/blog`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/blog/ai-transforms-customer-support-response-times`, lastModified: new Date('2026-09-15'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/5-metrics-every-support-team-should-track`, lastModified: new Date('2026-09-22'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/complete-guide-automated-ticket-routing`, lastModified: new Date('2026-09-29'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/embed`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
  ];
}
