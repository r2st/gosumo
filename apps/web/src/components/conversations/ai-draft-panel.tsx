'use client';

import { useState } from 'react';
import { Bot, Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApproveTask, useRejectTask } from '@/hooks/use-queries';
import type { HitlTask } from '@/lib/types';
import { friendlyError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * In-thread review card for a pending DRAFT_REVIEW task. Lets an operator approve
 * the AI draft as-is, edit it before sending, or reject and take over manually.
 */
export function AiDraftPanel({ task }: { task: HitlTask }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.aiDraft ?? '');
  const approve = useApproveTask();
  const reject = useRejectTask();
  // Approving or rejecting a draft sends (or suppresses) a real customer
  // message — an undecorated write, STAFF and above.
  const { canWrite } = usePermissions();

  const confidence = Math.round(task.aiConfidence ?? 0);
  const confidenceTone = confidence >= 90 ? 'success' : confidence >= 70 ? 'warning' : 'danger';
  const busy = approve.isPending || reject.isPending;

  return (
    <div className="border-t border-amber-500/20 bg-amber-500/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-amber-300">AI draft awaiting review</p>
            <p className="text-xs text-amber-400">{task.title}</p>
          </div>
        </div>
        <Badge tone={confidenceTone}>{confidence}% confidence</Badge>
      </div>

      {task.aiReasoning && (
        <p className="mb-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-amber-300">
          <span className="font-medium">Reasoning: </span>
          {task.aiReasoning}
        </p>
      )}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-amber-500/30 bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <div
          className={cn(
            'rounded-md border border-amber-500/20 bg-card px-3 py-2 text-sm text-foreground',
          )}
        >
          {draft || <span className="italic text-muted-foreground">No draft provided.</span>}
        </div>
      )}

      {(approve.isError || reject.isError) && (
        <p className="mt-2 text-xs text-danger">
          {friendlyError(approve.error ?? reject.error, 'That action didn’t go through. Please try again.')}
        </p>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="success"
            loading={approve.isPending}
            disabled={busy}
            onClick={() =>
              approve.mutate({
                id: task.id,
                editedResponse: editing && draft !== task.aiDraft ? draft : undefined,
              })
            }
          >
            <Check className="h-4 w-4" />
            {editing && draft !== task.aiDraft ? 'Send edited' : 'Approve & send'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((v) => !v)}>
            <Pencil className="h-4 w-4" /> {editing ? 'Cancel edit' : 'Edit'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={reject.isPending}
            disabled={busy}
            onClick={() => reject.mutate({ id: task.id })}
          >
            <X className="h-4 w-4" /> Reject & take over
          </Button>
        </div>
      )}
    </div>
  );
}
