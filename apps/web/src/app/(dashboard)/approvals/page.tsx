'use client';

import { useState } from 'react';
import { usePermissions } from '@/hooks/use-permissions';
import { CheckSquare, Check, Pencil, X } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { timeAgo } from '@/lib/format';
import { useApprovals, useResolveApproval } from '@/hooks/use-realty';
import type { Approval } from '@/lib/realty-types';

function confidenceTone(confidence: number): BadgeTone {
  if (confidence >= 90) return 'success';
  if (confidence >= 70) return 'warning';
  return 'danger';
}

export default function ApprovalsPage() {
  const { data, isLoading, isError, refetch } = useApprovals({ status: 'PENDING' });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Approval queue"
        description="AI drafts in the 70–89% confidence band — approve, edit, or reject before they send."
      />
      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {isLoading ? (
          <LoadingState label="Loading approval queue…" />
        ) : isError ? (
          <ErrorState message="Could not load approvals." onRetry={() => refetch()} />
        ) : !data || data.length === 0 ? (
          <EmptyState
            icon={CheckSquare}
            title="Queue is clear"
            description="No AI drafts are waiting for review. High-confidence replies send automatically; anything uncertain lands here."
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {data.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const resolve = useResolveApproval();
  // Resolving an approval posts to the review queue — an undecorated write, so
  // STAFF and above. A VIEWER can read the queue but not action it.
  const { canWrite } = usePermissions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(approval.draftText);

  const busy = resolve.isPending;

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={confidenceTone(approval.confidence)}>
              {approval.confidence}% confidence
            </Badge>
            {approval.intent && <Badge tone="neutral">{approval.intent}</Badge>}
          </div>
          <span className="text-xs text-muted-foreground">{timeAgo(approval.createdAt)}</span>
        </div>

        {editing ? (
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <p className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-sm">
            {approval.draftText}
          </p>
        )}

        {canWrite && (
          <div className="mt-4 flex flex-wrap gap-2">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="success"
                  loading={busy}
                  onClick={() =>
                    resolve.mutate({ id: approval.id, status: 'EDITED', editedText: text })
                  }
                >
                  <Check className="h-4 w-4" />
                  Send edited
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="success"
                  loading={busy}
                  onClick={() => resolve.mutate({ id: approval.id, status: 'APPROVED' })}
                >
                  <Check className="h-4 w-4" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy}
                  onClick={() => resolve.mutate({ id: approval.id, status: 'REJECTED' })}
                >
                  <X className="h-4 w-4" />
                  Reject
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
