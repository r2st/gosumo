import type { Metadata } from 'next';
import { LandingPage } from './landing-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'DoAide Desk — AI-powered client management across every channel',
  description:
    'Manage customer conversations across WhatsApp, Instagram, SMS, Web Chat, and Email through a single AI-driven interface. Built for small businesses in India.',
};

export default function Home() {
  return <LandingPage />;
}
