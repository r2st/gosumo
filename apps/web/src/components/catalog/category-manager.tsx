'use client';

import { useState, type FormEvent } from 'react';
import { FolderTree, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingState, EmptyState } from '@/components/ui/states';
import { useCategories, useCreateCategory, useDeleteCategory, useUpdateCategory } from '@/hooks/use-catalog';
import type { CatalogCategory } from '@/lib/commerce-types';

export function CategoryManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading } = useCategories();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const del = useDeleteCategory();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<CatalogCategory | null>(null);

  const categories = data?.categories ?? [];

  const reset = () => {
    setName('');
    setDescription('');
    setEditing(null);
  };

  const startEdit = (c: CatalogCategory) => {
    setEditing(c);
    setName(c.name);
    setDescription(c.description ?? '');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { name: name.trim(), description: description.trim() || undefined };
    if (!body.name) return;
    if (editing) update.mutate({ id: editing.id, body }, { onSuccess: reset });
    else create.mutate(body, { onSuccess: reset });
  };

  return (
    <Modal open={open} onClose={onClose} title="Manage categories" description="Group your catalog items.">
      <div className="space-y-5">
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{editing ? 'Edit category' : 'New category'}</p>
            {editing && (
              <button type="button" onClick={reset} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" /> Cancel edit
              </button>
            )}
          </div>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Beverages" required />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={create.isPending || update.isPending} disabled={!name.trim()}>
              {editing ? 'Save' : (<><Plus className="h-4 w-4" /> Add category</>)}
            </Button>
          </div>
        </form>

        {isLoading ? (
          <LoadingState className="py-8" />
        ) : categories.length === 0 ? (
          <EmptyState icon={FolderTree} title="No categories yet" description="Add one above to organise your catalog." className="py-8" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  {c.description && <p className="truncate text-xs text-muted-foreground">{c.description}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Badge tone="neutral">{c.itemCount} item{c.itemCount === 1 ? '' : 's'}</Badge>
                  <button onClick={() => startEdit(c)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={`Edit ${c.name}`}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => del.mutate(c.id)}
                    disabled={del.isPending}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-danger disabled:opacity-50"
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {del.isError && <p className="text-sm text-danger">Couldn’t delete — the category may still contain items.</p>}
      </div>
    </Modal>
  );
}
