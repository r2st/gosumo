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
    default: 'DoAide Inbox',
    template: '%s · DoAide Inbox',
  },
  description:
    'DoAide Inbox unifies WhatsApp, Instagram, SMS, Web Chat and Email into one AI-powered inbox for small businesses in India.',
  applicationName: 'DoAide Inbox',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'DoAide Inbox',
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
