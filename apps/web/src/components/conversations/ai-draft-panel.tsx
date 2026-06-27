'use client';

import { useState } from 'react';
import { Bot, Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApproveTask, useRejectTask } from '@/hooks/use-queries';
import type { HitlTask } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * In-thread review card for a pending DRAFT_REVIEW task. Lets an operator approve
 * the AI draft as-is, edit it before sending, or reject and take over manually.
 */
export function AiDraftPanel({ task }: { task: HitlTask }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.aiDraft ?? '');
  const approve = useApproveTask();
  const reject = useRejectTask();

  const confidence = Math.round(task.aiConfidence ?? 0);
  const confidenceTone = confidence >= 90 ? 'success' : confidence >= 70 ? 'warning' : 'danger';
  const busy = approve.isPending || reject.isPending;

  return (
    <div className="border-t border-amber-200 bg-amber-50/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-amber-900">AI draft awaiting review</p>
            <p className="text-xs text-amber-700">{task.title}</p>
          </div>
        </div>
        <Badge tone={confidenceTone}>{confidence}% confidence</Badge>
      </div>

      {task.aiReasoning && (
        <p className="mb-2 rounded-md bg-white/60 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Reasoning: </span>
          {task.aiReasoning}
        </p>
      )}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-amber-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <div className={cn('rounded-md border border-amber-200 bg-white px-3 py-2 text-sm text-foreground')}>
          {draft || <span className="italic text-muted-foreground">No draft provided.</span>}
        </div>
      )}

      {(approve.isError || reject.isError) && (
        <p className="mt-2 text-xs text-danger">
          {((approve.error ?? reject.error) as Error)?.message ?? 'Action failed.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="success"
          loading={approve.isPending}
          disabled={busy}
          onClick={() =>
            approve.mutate({ id: task.id, editedResponse: editing && draft !== task.aiDraft ? draft : undefined })
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
    </div>
  );
}
