'use client';

import { useEffect, useState } from 'react';
import { Bell, Mail, MessageSquare, Moon } from 'lucide-react';
import { useBusinessSettings, useUpdateBusinessSettings } from '@/hooks/use-settings';
import {
  SettingsCard,
  SaveButton,
  ReadOnlyFieldset,
  ReadOnlyNotice,
} from '@/components/settings/settings-kit';
import { usePermissions } from '@/hooks/use-permissions';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import type { BusinessSettings, NotificationType } from '@/lib/feature-types';

const EVENTS: { type: NotificationType; label: string; channels: string[] }[] = [
  { type: 'TASK_CREATED', label: 'New HITL task needs review', channels: ['In-app', 'Email'] },
  {
    type: 'CONVERSATION_ESCALATED',
    label: 'Conversation escalated to a human',
    channels: ['In-app', 'Email', 'SMS'],
  },
  { type: 'PAYMENT_RECEIVED', label: 'Payment received', channels: ['In-app', 'Email'] },
  { type: 'BOOKING_CREATED', label: 'New booking confirmed', channels: ['In-app', 'Email'] },
  { type: 'CHANNEL_ERROR', label: 'A channel went down', channels: ['In-app', 'Email', 'SMS'] },
];

type Form = Pick<
  BusinessSettings,
  | 'emailNotificationsEnabled'
  | 'smsNotificationsEnabled'
  | 'notificationEmail'
  | 'notificationPhone'
  | 'quietHoursEnabled'
  | 'quietHoursStart'
  | 'quietHoursEnd'
>;

export default function NotificationsPage() {
  const { data, isLoading, isError, refetch } = useBusinessSettings();
  const update = useUpdateBusinessSettings();
  // Notification preferences ride on PATCH /business/settings — @Roles(MANAGER).
  const { canManage } = usePermissions();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data) {
      setForm({
        emailNotificationsEnabled: data.emailNotificationsEnabled,
        smsNotificationsEnabled: data.smsNotificationsEnabled,
        notificationEmail: data.notificationEmail ?? '',
        notificationPhone: data.notificationPhone ?? '',
        quietHoursEnabled: data.quietHoursEnabled ?? false,
        quietHoursStart: data.quietHoursStart ?? '22:00',
        quietHoursEnd: data.quietHoursEnd ?? '08:00',
      });
    }
  }, [data]);

  if (isLoading) return <LoadingState />;
  if (isError || !data || !form) return <ErrorState onRetry={() => void refetch()} />;

  const patch = (p: Partial<Form>) => setForm((f) => f && { ...f, ...p });
  const dirty =
    form.emailNotificationsEnabled !== data.emailNotificationsEnabled ||
    form.smsNotificationsEnabled !== data.smsNotificationsEnabled ||
    (form.notificationEmail ?? '') !== (data.notificationEmail ?? '') ||
    (form.notificationPhone ?? '') !== (data.notificationPhone ?? '') ||
    !!form.quietHoursEnabled !== !!data.quietHoursEnabled ||
    (form.quietHoursStart ?? '') !== (data.quietHoursStart ?? '22:00') ||
    (form.quietHoursEnd ?? '') !== (data.quietHoursEnd ?? '08:00');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(form);
      }}
    >
      <ReadOnlyFieldset readOnly={!canManage} className="space-y-5">
        <SettingsCard
          title="Delivery channels"
          description="Where operational alerts are delivered to your team."
          footer={
            canManage ? (
              <SaveButton
                isPending={update.isPending}
                isSuccess={update.isSuccess}
                isError={update.isError}
                dirty={dirty}
              />
            ) : (
              <ReadOnlyNotice>
                Only a manager or owner can change notification settings.
              </ReadOnlyNotice>
            )
          }
        >
          <Switch
            checked={form.emailNotificationsEnabled}
            onChange={(v) => patch({ emailNotificationsEnabled: v })}
            label="Email notifications"
            description="Send alerts to a shared inbox."
          />
          {form.emailNotificationsEnabled && (
            <Field label="Notification email">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="email"
                  className="pl-9"
                  value={form.notificationEmail ?? ''}
                  onChange={(e) => patch({ notificationEmail: e.target.value })}
                  placeholder="alerts@business.in"
                />
              </div>
            </Field>
          )}

          <div className="border-t border-border pt-4">
            <Switch
              checked={form.smsNotificationsEnabled}
              onChange={(v) => patch({ smsNotificationsEnabled: v })}
              label="SMS notifications"
              description="Text high-priority alerts (escalations, outages)."
            />
          </div>
          {form.smsNotificationsEnabled && (
            <Field label="Notification phone">
              <div className="relative">
                <MessageSquare className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={form.notificationPhone ?? ''}
                  onChange={(e) => patch({ notificationPhone: e.target.value })}
                  placeholder="+91…"
                />
              </div>
            </Field>
          )}
        </SettingsCard>

        <SettingsCard
          title="Quiet hours"
          description="Pause non-urgent notifications during these hours (your business timezone)."
        >
          <Switch
            checked={!!form.quietHoursEnabled}
            onChange={(v) => patch({ quietHoursEnabled: v })}
            label="Enable quiet hours"
          />
          {form.quietHoursEnabled && (
            <div className="flex items-end gap-3">
              <Moon className="mb-2 h-4 w-4 text-muted-foreground" />
              <Field label="From">
                <Input
                  type="time"
                  value={form.quietHoursStart ?? '22:00'}
                  onChange={(e) => patch({ quietHoursStart: e.target.value })}
                />
              </Field>
              <Field label="To">
                <Input
                  type="time"
                  value={form.quietHoursEnd ?? '08:00'}
                  onChange={(e) => patch({ quietHoursEnd: e.target.value })}
                />
              </Field>
            </div>
          )}
        </SettingsCard>

        <SettingsCard
          title="Notification events"
          description="Templates that trigger alerts to your team."
        >
          <ul className="divide-y divide-border rounded-lg border border-border">
            {EVENTS.map((ev) => (
              <li key={ev.type} className="flex items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-2.5">
                  <Bell className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{ev.label}</span>
                </div>
                <div className="flex gap-1.5">
                  {ev.channels.map((c) => (
                    <Badge key={c} tone="neutral">
                      {c}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </SettingsCard>
      </ReadOnlyFieldset>
    </form>
  );
}
