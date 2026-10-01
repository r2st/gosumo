'use client';

import { Calendar, CheckCircle2, Link2, RefreshCw } from 'lucide-react';
import {
  useCalendarIntegration,
  useConnectCalendar,
  useDisconnectCalendar,
  useSyncCalendar,
} from '@/hooks/use-settings';
import { SettingsCard } from '@/components/settings/settings-kit';
import { usePermissions } from '@/hooks/use-permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { timeAgo } from '@/lib/format';

export default function IntegrationsPage() {
  const { data, isLoading, isError, error, refetch } = useCalendarIntegration();
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const sync = useSyncCalendar();
  // Connect and disconnect are @Roles(MANAGER) on /integrations/google-calendar.
  // "Sync now" posts to /bookings/calendar/sync, which is undecorated — STAFF+.
  const { canManage, canWrite } = usePermissions();

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const handleConnect = () => {
    connect.mutate(undefined, {
      onSuccess: (res) => {
        if (res?.authUrl) window.location.href = res.authUrl;
      },
    });
  };

  return (
    <SettingsCard
      title="Integrations"
      description="Connect third-party tools to sync your data with DoAide Inbox."
    >
      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border">
              <Calendar className="h-6 w-6 text-[#4285F4]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-medium text-foreground">Google Calendar</p>
                {data.connected ? (
                  <Badge tone="success">
                    <CheckCircle2 className="h-3 w-3" /> Connected
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not connected</Badge>
                )}
              </div>
              <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                Two-way sync of bookings with your Google Calendar so appointments never clash.
              </p>
              {data.connected && (
                <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {data.accountEmail && (
                    <div className="flex gap-1.5">
                      <dt className="font-medium text-foreground">Account:</dt>
                      <dd>{data.accountEmail}</dd>
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <dt className="font-medium text-foreground">Last synced:</dt>
                    <dd>{data.lastSyncedAt ? timeAgo(data.lastSyncedAt) : 'never'}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2 sm:flex-row">
            {data.connected ? (
              <>
                {canWrite && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={sync.isPending}
                    onClick={() => sync.mutate()}
                  >
                    <RefreshCw className="h-4 w-4" /> Sync now
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={disconnect.isPending}
                    onClick={() => disconnect.mutate()}
                  >
                    Disconnect
                  </Button>
                )}
              </>
            ) : (
              canManage && (
                <Button size="sm" loading={connect.isPending} onClick={handleConnect}>
                  <Link2 className="h-4 w-4" /> Connect
                </Button>
              )
            )}
          </div>
        </div>

        {sync.isSuccess && (
          <p className="mt-3 text-xs text-success">Calendar synced successfully.</p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        More integrations are on the way. Need one sooner? Let us know.
      </p>
    </SettingsCard>
  );
}
