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
    default: 'DoAide Desk',
    template: '%s · DoAide Desk',
  },
  description:
    'DoAide Desk is an AI-powered helpdesk for Indian businesses — one inbox for WhatsApp, Instagram, SMS, email and web chat, with AI-drafted replies and login-free ticket submission.',
  metadataBase: new URL('https://desk.doaide.com'),
  applicationName: 'DoAide Desk',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'DoAide Desk',
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
    title: 'DoAide Desk — AI Helpdesk for Indian Businesses',
    description:
      'One inbox for WhatsApp, Instagram, SMS, email and web chat. AI-drafted replies, smart routing, and support tickets customers can raise without signing up.',
    url: 'https://desk.doaide.com',
    siteName: 'DoAide',
    type: 'website',
    images: [
      {
        url: 'https://desk.doaide.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'DoAide Desk — AI Helpdesk for Indian Businesses',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'DoAide Desk — AI Helpdesk for Indian Businesses',
    description: 'One inbox for WhatsApp, email and web chat, with AI-drafted replies.',
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
              name: 'DoAide Desk',
              description:
                'AI-powered helpdesk and customer support platform for Indian businesses.',
              url: 'https://desk.doaide.com',
              applicationCategory: 'BusinessApplication',
              operatingSystem: 'Web',
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
              author: {
                '@type': 'Organization',
                name: 'Apprend Technologies',
                url: 'https://desk.doaide.com',
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
