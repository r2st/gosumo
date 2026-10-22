import type { MetadataRoute } from 'next';

// Dashboard routes sit behind login and only ever render a sign-in redirect to
// a crawler, so they are disallowed by prefix rather than left to be indexed
// as thin duplicate pages.
const PRIVATE_PREFIXES = [
  '/api/',
  '/auth/',
  '/dashboard',
  '/conversations',
  '/clients',
  '/leads',
  '/analytics',
  '/approvals',
  '/bookings',
  '/broker',
  '/cadences',
  '/catalog',
  '/exchange',
  '/import',
  '/intelligence',
  '/inventory',
  '/orders',
  '/payments',
  '/settings',
  '/sitevisits',
  '/reset-password',
  '/forgot-password',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/tools/', '/blog/', '/embed', '/support', '/about'],
        disallow: PRIVATE_PREFIXES,
      },
    ],
    sitemap: 'https://desk.doaide.com/sitemap.xml',
  };
}
