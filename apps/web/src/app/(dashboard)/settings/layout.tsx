'use client';

import { usePathname } from 'next/navigation';
import { Bot, Building2, CalendarClock, CreditCard, Bell, KeyRound, Radio, Rocket, ShieldCheck, Users } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { LinkTabs, type TabItem } from '@/components/ui/tabs';
import { useT } from '@/providers/language-provider';

const TABS: (Omit<TabItem, 'label'> & { match: string; labelKey: string })[] = [
  { key: 'profile', labelKey: 'settings.business', href: '/settings', match: '/settings', icon: Building2 },
  { key: 'setup', labelKey: 'settings.setup', href: '/settings/setup', match: '/settings/setup', icon: Rocket },
  { key: 'team', labelKey: 'settings.team', href: '/settings/team', match: '/settings/team', icon: Users },
  { key: 'channels', labelKey: 'settings.channels', href: '/settings/channels', match: '/settings/channels', icon: Radio },
  { key: 'ai', labelKey: 'settings.ai', href: '/settings/ai', match: '/settings/ai', icon: Bot },
  { key: 'notifications', labelKey: 'settings.notifications', href: '/settings/notifications', match: '/settings/notifications', icon: Bell },
  { key: 'billing', labelKey: 'settings.billing', href: '/settings/billing', match: '/settings/billing', icon: CreditCard },
  { key: 'privacy', labelKey: 'settings.privacy', href: '/settings/privacy', match: '/settings/privacy', icon: ShieldCheck },
  { key: 'api-keys', labelKey: 'settings.apiKeys', href: '/settings/api-keys', match: '/settings/api-keys', icon: KeyRound },
  { key: 'integrations', labelKey: 'settings.integrations', href: '/settings/integrations', match: '/settings/integrations', icon: CalendarClock },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  // Longest matching path wins so /settings/team doesn't also match /settings.
  const active = [...TABS]
    .sort((a, b) => b.match.length - a.match.length)
    .find((tab) => pathname === tab.match || pathname.startsWith(`${tab.match}/`));

  const items: TabItem[] = TABS.map(({ labelKey, match: _match, ...rest }) => ({
    ...rest,
    label: t(labelKey),
  }));

  return (
    <div>
      <PageHeader title={t('settings.title')} description="Manage your business profile, team, channels and AI behaviour." />
      <div className="border-b border-border bg-card px-4 lg:px-6">
        <LinkTabs items={items} activeKey={active?.key ?? 'profile'} />
      </div>
      <div className="mx-auto max-w-4xl space-y-5 p-4 lg:p-6">{children}</div>
    </div>
  );
}
