import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';
import { LanguageProvider, langInitScript } from '@/providers/language-provider';
import { ThemeProvider, themeInitScript } from '@/providers/theme-provider';
import { ToastProvider } from '@/providers/toast-provider';

export const metadata: Metadata = {
  title: {
    default: 'DoAide Desk',
    template: '%s · DoAide Desk',
  },
  description:
    'DoAide Desk unifies WhatsApp, Instagram, SMS, Web Chat and Email into one AI-powered inbox for small businesses in India.',
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
    title: 'DoAide Desk — AI-Powered Client Management',
    description:
      'Manage customer conversations across WhatsApp, Instagram, SMS, Web Chat, and Email through a single AI-driven interface.',
    url: 'https://desk.doaide.com',
    siteName: 'DoAide',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'DoAide Desk — AI-Powered Client Management',
    description: 'AI-powered omnichannel inbox for small businesses.',
  },
};

export const viewport: Viewport = {
  themeColor: '#0A0A0B',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: langInitScript }} />
        <Script
          defer
          src="https://analytics.doaide.com/script.js"
          data-website-id="98200829-3da5-474b-8ddd-88ef54b947e6"
          strategy="afterInteractive"
        />
      </head>
      <body>
        <ThemeProvider>
          <LanguageProvider>
            <QueryProvider>
              <ToastProvider>
                <AuthProvider>{children}</AuthProvider>
              </ToastProvider>
            </QueryProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
