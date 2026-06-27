'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ArrowLeft, Inbox } from 'lucide-react';
import {
  ConversationList,
  type ConvFilterState,
} from '@/components/conversations/conversation-list';
import { ConversationThread } from '@/components/conversations/conversation-thread';
import { EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils';

function ConversationsInbox() {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get('id');

  const [filters, setFilters] = useState<ConvFilterState>({
    q: '',
    status: '',
    channelType: '',
    assignedTo: '',
  });

  const select = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set('id', id);
    router.replace(`/conversations?${sp.toString()}`);
  };

  const clearSelection = () => {
    const sp = new URLSearchParams(params.toString());
    sp.delete('id');
    router.replace(`/conversations${sp.toString() ? `?${sp.toString()}` : ''}`);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* List panel — hidden on mobile when a thread is open */}
      <div
        className={cn(
          'w-full border-r border-border bg-card md:w-80 lg:w-96',
          selectedId ? 'hidden md:flex md:flex-col' : 'flex flex-col',
        )}
      >
        <ConversationList
          filters={filters}
          onFiltersChange={setFilters}
          selectedId={selectedId}
          onSelect={select}
        />
      </div>

      {/* Thread panel */}
      <div className={cn('min-w-0 flex-1', selectedId ? 'flex flex-col' : 'hidden md:flex md:flex-col')}>
        {selectedId ? (
          <>
            <button
              onClick={clearSelection}
              className="flex items-center gap-1.5 border-b border-border bg-card px-4 py-2 text-sm text-muted-foreground md:hidden"
            >
              <ArrowLeft className="h-4 w-4" /> Back to inbox
            </button>
            <div className="min-h-0 flex-1">
              <ConversationThread key={selectedId} conversationId={selectedId} />
            </div>
          </>
        ) : (
          <EmptyState
            icon={Inbox}
            title="Select a conversation"
            description="Choose a conversation from the list to view the message thread and respond."
          />
        )}
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={null}>
      <ConversationsInbox />
    </Suspense>
  );
}
