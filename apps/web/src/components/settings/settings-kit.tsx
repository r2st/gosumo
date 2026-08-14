'use client';

import type { ReactNode } from 'react';
import { AlertCircle, Check, Lock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, type ButtonProps } from '@/components/ui/button';

export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
          {footer}
        </div>
      )}
    </Card>
  );
}

/** Submit button reflecting a TanStack mutation's pending/success/error state. */
export function SaveButton({
  isPending,
  isSuccess,
  isError,
  dirty = true,
  children = 'Save changes',
  ...props
}: ButtonProps & { isPending?: boolean; isSuccess?: boolean; isError?: boolean; dirty?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {isSuccess && !isPending && (
        <span className="flex items-center gap-1 text-xs font-medium text-success">
          <Check className="h-3.5 w-3.5" /> Saved
        </span>
      )}
      {isError && !isPending && (
        <span className="flex items-center gap-1 text-xs font-medium text-danger">
          <AlertCircle className="h-3.5 w-3.5" /> Couldn’t save
        </span>
      )}
      <Button type="submit" loading={isPending} disabled={!dirty || isPending} {...props}>
        {children}
      </Button>
    </div>
  );
}

/**
 * Makes a settings form read-only for an operator whose role cannot save it.
 *
 * A disabled `<fieldset>` natively disables every input, select, textarea and
 * button inside it, so a control added to the form later is covered without
 * anyone remembering to gate it — the same fail-closed reasoning as the API's
 * guard-level write default. `display: contents` keeps the element out of the
 * layout, so wrapping an existing form changes nothing visually.
 *
 * Pair it with a {@link ReadOnlyNotice} in the footer in place of the
 * {@link SaveButton}, so the form explains itself rather than just going inert.
 *
 * `className` defaults to `contents`, which is right when the wrapper sits
 * around a single card. Wrapping *several* cards that were spaced by a
 * `space-y-*` on the parent needs that class moved onto the fieldset instead:
 * `space-y-*` compiles to a sibling selector over real DOM children, and
 * `display: contents` removes the fieldset from layout without making its
 * children siblings of anything. Left as `contents` there, the gaps collapse.
 */
export function ReadOnlyFieldset({
  readOnly,
  children,
  className = 'contents',
}: {
  readOnly: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset disabled={readOnly} className={className}>
      {children}
    </fieldset>
  );
}

/** Footer note standing in for the Save button when the operator cannot save. */
export function ReadOnlyNotice({
  children = 'Your role has read-only access to these settings.',
}: {
  children?: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Lock className="h-3.5 w-3.5 shrink-0" /> {children}
    </span>
  );
}

export function FormRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}
