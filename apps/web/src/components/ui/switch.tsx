'use client';

import { cn } from '@/lib/utils';

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  ariaLabel,
  description,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Rendered as visible text beside the toggle, and used as its name. */
  label?: string;
  /**
   * The accessible name when the visible text lives outside this component —
   * a sibling `<span>`, a table row, a card title. Use this instead of `label`
   * there: `label` would render a *second* copy of the text.
   */
  ariaLabel?: string;
  description?: string;
  id?: string;
}) {
  const toggle = (
    <button
      type="button"
      role="switch"
      id={id}
      // A `<button>` with no text content has no accessible name, and a
      // wrapping `<label>` does not give one — so without this the control
      // announces as an unnamed switch: a screen reader user hears "on"/"off"
      // with no idea what is being toggled.
      aria-label={ariaLabel ?? label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );

  if (!label && !description) return toggle;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col">
        {label && <span className="text-sm font-medium text-foreground">{label}</span>}
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </div>
      {toggle}
    </div>
  );
}
