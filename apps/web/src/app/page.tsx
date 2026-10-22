import type { Metadata } from 'next';
import { LandingPage } from './landing-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'DoAide Desk — AI Helpdesk & Customer Support for Indian Businesses' },
  description:
    'Answer customers on WhatsApp, Instagram, SMS, email and web chat from one AI-powered inbox. Free to start, priced in rupees, and customers raise tickets without signing up.',
  alternates: { canonical: '/' },
};

export default function Home() {
  return <LandingPage />;
}
