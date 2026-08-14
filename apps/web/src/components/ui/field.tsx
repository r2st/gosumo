import { Children, cloneElement, isValidElement, useId, type LabelHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  /**
   * Only needed when the control is buried inside a wrapper. A `Field` whose
   * child is the control itself wires the two together on its own.
   */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  // A `<label>` with no `for` and no control nested inside it is announced as
  // loose text: the screen-reader user hears "Email" and then, separately, an
  // unnamed edit box. Call sites almost never pass `htmlFor`, so the field
  // mints an id and hands it to its control rather than trusting them to.
  const generatedId = useId();
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  const childId =
    isValidElement<{ id?: string }>(child) ? (child.props.id ?? generatedId) : undefined;
  const controlId = htmlFor ?? childId;

  const control =
    // Respect an id the caller set — it may already be referenced elsewhere
    // (`aria-describedby`, a `<datalist>`), and overwriting it would break that.
    !htmlFor && isValidElement<{ id?: string }>(child) && child.props.id === undefined
      ? cloneElement(child, { id: generatedId })
      : children;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={controlId}>{label}</Label>}
      {control}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
