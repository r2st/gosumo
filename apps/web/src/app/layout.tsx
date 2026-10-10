import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';
import { LanguageProvider, langInitScript } from '@/providers/language-provider';
import { ThemeProvider, themeInitScript } from '@/providers/theme-provider';
import { ToastProvider } from '@/providers/toast-provider';
import { FeedbackWidget } from '@/components/feedback-widget';

export const metadata: Metadata = {
  title: {
    default: 'GoSumo Realty',
    template: '%s · GoSumo Realty',
  },
  description:
    'GoSumo Realty is an AI-powered lead management platform for real estate brokers in India — capture, qualify and follow up across WhatsApp, portals and Meta ads.',
  applicationName: 'GoSumo Realty',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'GoSumo Realty',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: ['/favicon.ico'],
    apple: [{ url: '/favicon-192x192.png', sizes: '192x192', type: 'image/png' }],
  },
  openGraph: {
    title: 'GoSumo Realty — AI-Powered Lead Management',
    description:
      'AI-powered lead management for real estate brokers — capture buyers from WhatsApp, portals and Meta ads, qualify with AI, and close more deals.',
    url: 'https://gosumo.aiknol.com',
    siteName: 'GoSumo',
    type: 'website',
    images: [
      {
        url: 'https://gosumo.aiknol.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'GoSumo Realty — AI-Powered Lead Management',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'GoSumo Realty — AI-Powered Lead Management',
    description: 'AI-powered lead management for real estate brokers.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0A0A0B' },
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: langInitScript }} />
        <Script
          defer
          src="https://analytics.doaide.com/script.js"
          data-website-id="7b40a0e8-42a2-4202-aff7-63ebf108d6da"
          strategy="afterInteractive"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'GoSumo Realty',
              description:
                'AI-powered lead management platform for real estate brokers in India.',
              url: 'https://gosumo.aiknol.com',
              applicationCategory: 'BusinessApplication',
              operatingSystem: 'Web',
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
              author: {
                '@type': 'Organization',
                name: 'Apprend Technologies',
                url: 'https://gosumo.aiknol.com',
              },
            }),
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <LanguageProvider>
            <QueryProvider>
              <ToastProvider>
                <AuthProvider>
                  {children}
                  <FeedbackWidget />
                </AuthProvider>
              </ToastProvider>
            </QueryProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
