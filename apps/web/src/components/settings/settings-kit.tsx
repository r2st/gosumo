'use client';

import type { ReactNode } from 'react';
import { AlertCircle, Check } from 'lucide-react';
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
      {footer && <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">{footer}</div>}
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

export function FormRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}
