'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, Send } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/status-badge';
import { ChannelIcon, channelLabel } from '@/components/channel-icon';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { MessageBubble, DayDivider } from './message-bubble';
import { AiDraftPanel } from './ai-draft-panel';
import {
  useConversation,
  useEscalateConversation,
  useMessages,
  useResolveConversation,
  useSendMessage,
  useUpdateConversation,
} from '@/hooks/use-queries';
import { formatDayLabelIST, istDayKey } from '@/lib/format';
import { friendlyError } from '@/lib/errors';
import type { HitlTask, Message } from '@/lib/types';
import { usePermissions } from '@/hooks/use-permissions';

const QUICK_REPLIES = [
  'Thanks for reaching out! How can I help? 😊',
  'Could you share a few more details?',
  'Your request is being processed. We&apos;ll update you shortly.',
  'Is there anything else I can help you with?',
];

export function ConversationThread({ conversationId }: { conversationId: string }) {
  const convQ = useConversation(conversationId, ['client', 'tasks']);
  const messagesQ = useMessages(conversationId);
  const send = useSendMessage(conversationId);
  const resolve = useResolveConversation();
  const escalate = useEscalateConversation();
  const update = useUpdateConversation();
  // Resolving, escalating, snoozing and replying are all undecorated writes —
  // STAFF and above. The thread itself stays readable for a VIEWER.
  const { canWrite } = usePermissions();

  const [reply, setReply] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = messagesQ.data?.data ?? [];

  // Group consecutive messages by their IST calendar day so the thread can show
  // a centered date pill ("Today", "Yesterday", "3 Jul 2026") between days.
  const dayGroups = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: Message[] }> = [];
    for (const msg of messages) {
      const key = istDayKey(msg.timestamp);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(msg);
      else groups.push({ key, label: formatDayLabelIST(msg.timestamp), items: [msg] });
    }
    return groups;
  }, [messages]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const conversation = convQ.data;
  const pendingTask = (conversation as typeof conversation & { tasks?: HitlTask[] })?.tasks?.find(
    (t) => t.type === 'DRAFT_REVIEW' && t.status === 'PENDING',
  );

  function onSend() {
    const text = reply.trim();
    if (!text) return;
    send.mutate(text, { onSuccess: () => setReply('') });
  }

  if (convQ.isLoading) return <LoadingState label="Loading conversation…" />;
  if (convQ.isError || !conversation)
    return <ErrorState error={convQ.error} onRetry={() => convQ.refetch()} />;

  const isResolved = conversation.status === 'RESOLVED';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
        <Avatar
          name={conversation.client?.name ?? 'Unknown'}
          src={conversation.client?.avatarUrl}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">
              {conversation.client?.name ?? 'Unknown client'}
            </p>
            <ChannelIcon channel={conversation.channelType} />
            {conversation.aiHandling && <Badge tone="primary">AI handling</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {channelLabel(conversation.channelType)}
            {conversation.client?.phone ? ` · ${conversation.client.phone}` : ''}
          </p>
        </div>
        <StatusBadge value={conversation.status} />
      </div>

      {/* Status controls */}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
          {isResolved ? (
            <Button
              size="sm"
              variant="outline"
              loading={update.isPending}
              onClick={() => update.mutate({ id: conversationId, status: 'OPEN' })}
            >
              <RotateCcw className="h-4 w-4" /> Reopen
            </Button>
          ) : (
            <Button
              size="sm"
              variant="success"
              loading={resolve.isPending}
              onClick={() => resolve.mutate({ id: conversationId })}
            >
              <CheckCircle2 className="h-4 w-4" /> Resolve
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            loading={escalate.isPending}
            onClick={() => {
              const reason = window.prompt('Reason for escalation?') ?? '';
              if (reason.trim())
                escalate.mutate({ id: conversationId, reason: reason.trim(), priority: 'HIGH' });
            }}
          >
            <AlertTriangle className="h-4 w-4" /> Escalate
          </Button>
          {/* Snooze maps to PENDING — surfaces the thread for later without resolving it. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isResolved}
            loading={update.isPending}
            onClick={() => update.mutate({ id: conversationId, status: 'PENDING' })}
          >
            <Clock3 className="h-4 w-4" /> Snooze
          </Button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 space-y-2 overflow-y-auto bg-muted/20 p-4 scrollbar-thin"
      >
        {messagesQ.isLoading ? (
          <LoadingState label="Loading messages…" />
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No messages in this conversation yet.
          </p>
        ) : (
          dayGroups.map((group) => (
            <div key={group.key} className="space-y-2">
              <DayDivider label={group.label} />
              {group.items.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
            </div>
          ))
        )}
      </div>

      {/* AI draft review (HITL) */}
      {pendingTask && <AiDraftPanel task={pendingTask} />}

      {/* Quick replies */}
      {canWrite && (
        <div className="flex flex-wrap gap-1.5 border-t border-border bg-card px-4 pt-3">
          {QUICK_REPLIES.map((q) => (
            <button
              key={q}
              onClick={() => setReply(q.replace('&apos;', "'"))}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {q.replace('&apos;', "'")}
            </button>
          ))}
        </div>
      )}

      {/* Reply box */}
      {canWrite && (
        <div className="flex items-end gap-2 border-t border-border bg-card p-3">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder="Type a reply… (Enter to send, Shift+Enter for newline)"
            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            onClick={onSend}
            loading={send.isPending}
            disabled={!reply.trim()}
            size="icon"
            className="h-10 w-10"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}
      {send.isError && (
        // The reply text is only cleared on success, so it is still in the box
        // and re-sending is just running the same handler again.
        <div className="flex items-center gap-2 px-4 pb-2 text-xs text-danger">
          <span>{friendlyError(send.error, 'Your reply didn’t send.')}</span>
          <button
            type="button"
            onClick={onSend}
            disabled={send.isPending || !reply.trim()}
            className="rounded border border-current px-2 py-0.5 font-medium hover:bg-danger/10 disabled:opacity-50"
          >
            Retry send
          </button>
        </div>
      )}
    </div>
  );
}
