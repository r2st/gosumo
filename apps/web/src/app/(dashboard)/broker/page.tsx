'use client';

import {
  Bell,
  BellOff,
  Flame,
  CheckSquare,
  Clock,
  Repeat,
  Users,
  ShieldAlert,
  Mic,
  MicOff,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { LoadingState, EmptyState } from '@/components/ui/states';
import { ReadOnlyFieldset } from '@/components/settings/settings-kit';
import { timeAgo } from '@/lib/format';
import {
  useBrokerConsole,
  useBrokerAlerts,
  useBrokerSettings,
  useUpdateBrokerSettings,
  useMarkAlertRead,
  useMarkAllAlertsRead,
} from '@/hooks/use-realty';
import { useVoiceCommands, type VoiceCommandStatus } from '@/hooks/use-voice';
import {
  AUTONOMY_LABELS,
  type AutonomyLevel,
  type BrokerAlert,
  type BrokerAlertType,
} from '@/lib/realty-types';

const ALERT_TONE: Record<BrokerAlertType, BadgeTone> = {
  HOT_LEAD: 'danger',
  MORNING_BRIEFING: 'info',
  APPROVAL_PENDING: 'warning',
  TAKEOVER: 'primary',
  VISIT_REMINDER: 'success',
};

export default function BrokerConsolePage() {
  const consoleQ = useBrokerConsole();
  const m = consoleQ.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Broker console"
        description="Your command center — pipeline health, the notification feed, and the AI autonomy dial."
      />

      <div className="space-y-6 overflow-auto p-4 lg:p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard
            label="Active leads"
            value={String(m?.activeLeads ?? 0)}
            icon={Users}
            loading={consoleQ.isLoading}
          />
          <KpiCard
            label="Hot leads"
            value={String(m?.hotLeads ?? 0)}
            icon={Flame}
            iconClassName="bg-rose-500/15 text-rose-400"
            loading={consoleQ.isLoading}
          />
          <KpiCard
            label="To approve"
            value={String(m?.pendingApprovals ?? 0)}
            icon={CheckSquare}
            iconClassName="bg-amber-500/15 text-amber-400"
            loading={consoleQ.isLoading}
          />
          <KpiCard
            label="Follow-ups due"
            value={String(m?.followupsDueToday ?? 0)}
            icon={Clock}
            iconClassName="bg-sky-500/15 text-sky-400"
            loading={consoleQ.isLoading}
          />
          <KpiCard
            label="Active cadences"
            value={String(m?.activeCadences ?? 0)}
            icon={Repeat}
            loading={consoleQ.isLoading}
          />
          <KpiCard
            label="AI-handled"
            value={`${m?.aiHandledPct ?? 0}%`}
            icon={ShieldAlert}
            iconClassName="bg-emerald-500/15 text-emerald-400"
            loading={consoleQ.isLoading}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <NotificationCenter />
          </div>
          <AutonomyDial />
        </div>

        <VoiceCommandHistory />
      </div>
    </div>
  );
}

const VOICE_STATUS_TONE: Record<VoiceCommandStatus, BadgeTone> = {
  executed: 'success',
  not_understood: 'neutral',
  unresolved: 'warning',
  failed: 'danger',
};

const VOICE_STATUS_LABEL: Record<VoiceCommandStatus, string> = {
  executed: 'done',
  not_understood: 'not understood',
  unresolved: 'needs confirm',
  failed: 'failed',
};

function VoiceCommandHistory() {
  const { data, isLoading } = useVoiceCommands();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="h-5 w-5" />
          Voice commands
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState label="Loading voice commands…" />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={MicOff}
            title="No voice commands yet"
            description='Dictate instructions on WhatsApp — e.g. "pause follow-ups for Rahul" or "Serene Heights 2BHK now 94L".'
          />
        ) : (
          <ul className="divide-y divide-border">
            {data.map((cmd) => {
              const status = (
                cmd.status in VOICE_STATUS_TONE ? cmd.status : 'not_understood'
              ) as VoiceCommandStatus;
              return (
                <li key={cmd.id} className="flex items-start gap-3 py-3">
                  <Badge tone={VOICE_STATUS_TONE[status]} className="mt-0.5 shrink-0">
                    {VOICE_STATUS_LABEL[status]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm">“{cmd.transcription}”</p>
                    <p className="text-xs text-muted-foreground">{cmd.detail}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {timeAgo(cmd.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NotificationCenter() {
  const { data, isLoading } = useBrokerAlerts();
  const markRead = useMarkAlertRead();
  const markAll = useMarkAllAlertsRead();
  // Marking an alert read posts to /realty/broker/alerts — an undecorated
  // write, so STAFF and above.
  const { canWrite } = usePermissions();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notifications
          {data && data.unread > 0 && <Badge tone="danger">{data.unread}</Badge>}
        </CardTitle>
        {data && data.unread > 0 && canWrite && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => markAll.mutate()}
            loading={markAll.isPending}
          >
            Mark all read
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingState label="Loading notifications…" />
        ) : !data || data.alerts.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title="All caught up"
            description="Hot-lead alerts, briefings, and takeovers will appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {data.alerts.map((alert: BrokerAlert) => (
              <li
                key={alert.id}
                className={`flex items-start gap-3 py-3 ${alert.isRead ? 'opacity-60' : ''}`}
              >
                <Badge tone={ALERT_TONE[alert.type]} className="mt-0.5 shrink-0">
                  {alert.type.replace('_', ' ').toLowerCase()}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{alert.title}</p>
                  {alert.body && (
                    <p className="truncate text-xs text-muted-foreground">{alert.body}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">{timeAgo(alert.createdAt)}</span>
                  {!alert.isRead && canWrite && (
                    <button
                      onClick={() => markRead.mutate(alert.id)}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AutonomyDial() {
  const { data: settings, isLoading } = useBrokerSettings();
  const update = useUpdateBrokerSettings();
  // PATCH /realty/broker/settings is an undecorated write — STAFF and above.
  const { canWrite } = usePermissions();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Autonomy dial</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !settings ? (
          <LoadingState label="Loading settings…" />
        ) : (
          <ReadOnlyFieldset readOnly={!canWrite} className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium">AI independence</label>
              <Select
                value={settings.autonomyLevel}
                onChange={(e) => update.mutate({ autonomyLevel: e.target.value as AutonomyLevel })}
                options={(Object.keys(AUTONOMY_LABELS) as AutonomyLevel[]).map((level) => ({
                  value: level,
                  label: AUTONOMY_LABELS[level],
                }))}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <label className="font-medium">Auto-send threshold</label>
                <span className="font-semibold">{settings.autoApproveThreshold}%</span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                step={1}
                value={settings.autoApproveThreshold}
                onChange={(e) => update.mutate({ autoApproveThreshold: Number(e.target.value) })}
                className="w-full accent-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                In Assisted / Autonomous mode, the AI only auto-sends at or above this confidence.
              </p>
            </div>

            <Switch
              checked={settings.killSwitch}
              onChange={(next) => update.mutate({ killSwitch: next })}
              label="Kill switch"
              description="Pause all autonomous sends immediately."
            />

            <Switch
              checked={settings.briefingEnabled}
              onChange={(next) => update.mutate({ briefingEnabled: next })}
              label="Morning briefing"
              description={`Daily digest at ${settings.briefingHour}:${String(settings.briefingMinute).padStart(2, '0')} IST.`}
            />
          </ReadOnlyFieldset>
        )}
      </CardContent>
    </Card>
  );
}
