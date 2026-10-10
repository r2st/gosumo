import type { Metadata } from 'next';
import { LandingPage } from './landing-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'GoSumo Realty — AI-powered lead management for real estate brokers',
  description:
    'Capture, qualify and follow up on property leads across WhatsApp, portals and Meta ads through a single AI-driven interface. Built for real estate brokers in India.',
};

export default function Home() {
  return <LandingPage />;
}
