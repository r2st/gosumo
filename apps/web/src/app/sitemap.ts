import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://gosumo.aiknol.com';
  return [
    { url: base, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/about`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/tools`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/tools/response-time-calculator`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/tools/ticket-volume-forecaster`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/tools/csat-calculator`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/blog`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/blog/ai-transforms-customer-support-response-times`, lastModified: new Date('2026-09-15'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/5-metrics-every-support-team-should-track`, lastModified: new Date('2026-09-22'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/complete-guide-automated-ticket-routing`, lastModified: new Date('2026-09-29'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/ai-helpdesk-revolution-indian-smbs`, lastModified: new Date('2026-10-06'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/customer-support-automation-reduce-costs`, lastModified: new Date('2026-10-08'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/ticketing-best-practices-indian-smbs`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/best-help-desk-software-small-business-india`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/knowledge-base-guide-indian-business`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/whatsapp-customer-support-indian-business-guide`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/best-crm-for-freelancers-india`, lastModified: new Date('2026-10-08'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/ai-client-management-small-business`, lastModified: new Date('2026-10-08'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/client-retention-strategies-service-businesses`, lastModified: new Date('2026-10-08'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/client-management-software-indian-businesses`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/crm-for-freelancers-india-complete-guide`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/blog/lead-tracking-for-smbs-india`, lastModified: new Date('2026-10-10'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/embed`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
  ];
}
