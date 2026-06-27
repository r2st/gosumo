'use client';

import { Building2, CreditCard, Globe, Mail, Phone, Shield, User } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/providers/auth-provider';
import { formatDateIST } from '@/lib/format';

export default function SettingsPage() {
  const { user, business, logout } = useAuth();

  return (
    <div>
      <PageHeader title="Settings" description="Manage your profile, business and workspace." />

      <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-2 lg:p-6">
        {/* Profile */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <User className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Your profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar name={user?.name ?? 'User'} src={user?.avatarUrl} size="lg" />
              <div>
                <p className="font-semibold">{user?.name}</p>
                <p className="text-sm text-muted-foreground">{user?.email}</p>
                {user && <Badge tone="primary" className="mt-1">{user.role}</Badge>}
              </div>
            </div>
            <Row icon={Shield} label="Two-factor auth">
              <Badge tone={user?.twoFactorEnabled ? 'success' : 'warning'}>
                {user?.twoFactorEnabled ? 'Enabled' : 'Not enabled'}
              </Badge>
            </Row>
            <Row icon={Mail} label="Member since">
              <span className="text-sm">{formatDateIST(user?.createdAt)}</span>
            </Row>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </CardContent>
        </Card>

        {/* Business */}
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Business profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-lg font-semibold">{business?.name ?? '—'}</p>
              <p className="text-sm text-muted-foreground">{business?.industry}</p>
            </div>
            {business?.phone && <Row icon={Phone} label="Phone"><span className="text-sm">{business.phone}</span></Row>}
            {business?.email && <Row icon={Mail} label="Email"><span className="text-sm">{business.email}</span></Row>}
            {business?.website && (
              <Row icon={Globe} label="Website">
                <a href={business.website} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                  {business.website}
                </a>
              </Row>
            )}
            <Row icon={CreditCard} label="Subscription">
              <div className="flex items-center gap-1.5">
                <Badge tone="primary">{business?.subscriptionPlan ?? 'FREE'}</Badge>
                <Badge tone={business?.subscriptionStatus === 'ACTIVE' ? 'success' : 'warning'}>
                  {business?.subscriptionStatus ?? '—'}
                </Badge>
              </div>
            </Row>
          </CardContent>
        </Card>

        {/* Other settings placeholders */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                { title: 'Channels', desc: 'Connect WhatsApp, Instagram, SMS, Web & Email' },
                { title: 'Team members', desc: 'Invite and manage roles' },
                { title: 'AI configuration', desc: 'Confidence thresholds & prompts' },
              ].map((s) => (
                <div key={s.title} className="rounded-lg border border-border p-4">
                  <p className="text-sm font-semibold">{s.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{s.desc}</p>
                  <Button variant="ghost" size="sm" className="mt-2 px-0 text-primary" disabled>
                    Configure →
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof User;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border pt-3">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" /> {label}
      </span>
      {children}
    </div>
  );
}
