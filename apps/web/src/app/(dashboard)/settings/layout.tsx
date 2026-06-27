'use client';

import { usePathname } from 'next/navigation';
import { Bot, Building2, CalendarClock, CreditCard, Bell, KeyRound, Radio, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { LinkTabs, type TabItem } from '@/components/ui/tabs';

const TABS: (TabItem & { match: string })[] = [
  { key: 'profile', label: 'Business', href: '/settings', match: '/settings', icon: Building2 },
  { key: 'team', label: 'Team', href: '/settings/team', match: '/settings/team', icon: Users },
  { key: 'channels', label: 'Channels', href: '/settings/channels', match: '/settings/channels', icon: Radio },
  { key: 'ai', label: 'AI', href: '/settings/ai', match: '/settings/ai', icon: Bot },
  { key: 'notifications', label: 'Notifications', href: '/settings/notifications', match: '/settings/notifications', icon: Bell },
  { key: 'billing', label: 'Billing', href: '/settings/billing', match: '/settings/billing', icon: CreditCard },
  { key: 'api-keys', label: 'API Keys', href: '/settings/api-keys', match: '/settings/api-keys', icon: KeyRound },
  { key: 'integrations', label: 'Integrations', href: '/settings/integrations', match: '/settings/integrations', icon: CalendarClock },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Longest matching path wins so /settings/team doesn't also match /settings.
  const active = [...TABS]
    .sort((a, b) => b.match.length - a.match.length)
    .find((t) => pathname === t.match || pathname.startsWith(`${t.match}/`));

  return (
    <div>
      <PageHeader title="Settings" description="Manage your business profile, team, channels and AI behaviour." />
      <div className="border-b border-border bg-card px-4 lg:px-6">
        <LinkTabs items={TABS} activeKey={active?.key ?? 'profile'} />
      </div>
      <div className="mx-auto max-w-4xl space-y-5 p-4 lg:p-6">{children}</div>
    </div>
  );
}
