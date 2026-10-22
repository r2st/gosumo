import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Create your free account',
  description: 'Start DoAide Desk free — an AI helpdesk for Indian businesses with one inbox for WhatsApp, Instagram, SMS, email and web chat.',
  alternates: { canonical: '/register' },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
