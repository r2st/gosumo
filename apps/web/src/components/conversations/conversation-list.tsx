'use client';

import { Search } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ChannelIcon } from '@/components/channel-icon';
import { StatusBadge } from '@/components/status-badge';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { useConversations } from '@/hooks/use-queries';
import { usePullToRefresh, PullToRefreshIndicator } from '@/hooks/use-pull-to-refresh';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ChannelType, ConversationStatus } from '@/lib/types';
import { MessagesSquare } from 'lucide-react';

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Open', value: 'OPEN' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Escalated', value: 'ESCALATED' },
  { label: 'Bot handling', value: 'BOT_HANDLING' },
  { label: 'Resolved', value: 'RESOLVED' },
];

const CHANNEL_OPTIONS = [
  { label: 'All channels', value: '' },
  { label: 'WhatsApp', value: 'WHATSAPP' },
  { label: 'Instagram', value: 'INSTAGRAM' },
  { label: 'SMS', value: 'SMS' },
  { label: 'Web Chat', value: 'WEB_CHAT' },
  { label: 'Email', value: 'EMAIL' },
];

const ASSIGNEE_OPTIONS = [
  { label: 'Anyone', value: '' },
  { label: 'Assigned to me', value: 'me' },
  { label: 'Unassigned', value: 'unassigned' },
];

export interface ConvFilterState {
  q: string;
  status: string;
  channelType: string;
  assignedTo: string;
}

export function ConversationList({
  filters,
  onFiltersChange,
  selectedId,
  onSelect,
}: {
  filters: ConvFilterState;
  onFiltersChange: (next: ConvFilterState) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useConversations({
    include: 'client',
    q: filters.q || undefined,
    status: (filters.status || undefined) as ConversationStatus | undefined,
    channelType: filters.channelType || undefined,
    assignedTo: filters.assignedTo || undefined,
    limit: 50,
  });

  const set = (patch: Partial<ConvFilterState>) => onFiltersChange({ ...filters, ...patch });

  // Pull-to-refresh (touch only) on the conversation list.
  const { containerRef, pullDistance, isRefreshing } = usePullToRefresh<HTMLDivElement>(() => refetch());

  return (
    <div className="flex h-full flex-col">
      {/* Search + filters */}
      <div className="space-y-2 border-b border-border bg-card p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search conversations…"
            className="pl-8"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Select value={filters.status} onChange={(e) => set({ status: e.target.value })} options={STATUS_OPTIONS} className="text-xs" />
          <Select value={filters.channelType} onChange={(e) => set({ channelType: e.target.value })} options={CHANNEL_OPTIONS} className="text-xs" />
          <Select value={filters.assignedTo} onChange={(e) => set({ assignedTo: e.target.value })} options={ASSIGNEE_OPTIONS} className="text-xs" />
        </div>
      </div>

      {/* List */}
      <div ref={containerRef} className="relative flex-1 overflow-y-auto scrollbar-thin">
        <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
        {isLoading ? (
          <LoadingState label="Loading…" />
        ) : isError ? (
          <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />
        ) : !data || data.data.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No conversations" description="Try adjusting your filters." className="py-12" />
        ) : (
          <ul className="divide-y divide-border">
            {data.data.map((c) => {
              const active = c.id === selectedId;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.id)}
                    className={cn(
                      'flex w-full gap-3 px-3 py-3 text-left transition-colors hover:bg-muted',
                      active && 'bg-accent hover:bg-accent',
                    )}
                  >
                    <Avatar name={c.client?.name ?? 'Unknown'} src={c.client?.avatarUrl} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{c.client?.name ?? 'Unknown'}</p>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(c.lastMessageAt)}</span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{c.lastMessagePreview ?? 'No messages'}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <ChannelIcon channel={c.channelType as ChannelType} />
                        <StatusBadge value={c.status} />
                        {c.unreadCount > 0 && (
                          <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                            {c.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
