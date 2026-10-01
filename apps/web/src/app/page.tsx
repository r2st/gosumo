import type { Metadata } from 'next';
import { LandingPage } from './landing-page';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'DoAide Desk — AI lead manager for real estate',
  description:
    'Every lead answered in 30 seconds. Every buyer qualified on Budget-Location-Timeline-Configuration. Every follow-up kept for 90 days. WhatsApp-native AI for Indian real estate brokers.',
};

export default function Home() {
  return <LandingPage />;
}
