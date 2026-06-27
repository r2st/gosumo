'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Input for a write-only secret. When a value is already stored, the field
 * starts empty and shows a masked hint (•••• + last 4). Typing replaces the
 * stored secret; leaving it blank keeps the existing one.
 */
export function SecretInput({
  value,
  onChange,
  configured,
  last4,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  configured?: boolean;
  last4?: string;
  placeholder?: string;
  id?: string;
}) {
  const [reveal, setReveal] = useState(false);

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? 'Leave blank to keep current secret' : placeholder}
          className="pr-10"
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? 'Hide secret' : 'Show secret'}
            tabIndex={-1}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
      {configured && !value && (
        <p className={cn('flex items-center gap-1 text-xs text-muted-foreground')}>
          <span className="font-mono tracking-wider">••••••••{last4 ?? '••••'}</span>
          <span>· stored securely</span>
        </p>
      )}
    </div>
  );
}
