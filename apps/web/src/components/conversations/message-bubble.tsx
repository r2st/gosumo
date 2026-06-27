import { Bot, Check, CheckCheck, Clock, FileText, ImageIcon, MapPin, AlertCircle } from 'lucide-react';
import type { Message } from '@/lib/types';
import { formatTimeIST } from '@/lib/format';
import { paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';

function MessageBody({ message }: { message: Message }) {
  const c = message.content;
  switch (c.type) {
    case 'TEXT':
      return <p className="whitespace-pre-wrap break-words">{c.text}</p>;
    case 'IMAGE':
      return (
        <div className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={c.url} alt={c.caption ?? 'image'} className="max-h-60 rounded-md object-cover" />
          {c.caption && <p className="break-words">{c.caption}</p>}
        </div>
      );
    case 'DOCUMENT':
      return (
        <a href={c.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
          <FileText className="h-4 w-4" /> {c.filename}
        </a>
      );
    case 'LOCATION':
      return (
        <span className="flex items-center gap-1">
          <MapPin className="h-4 w-4" /> {c.name ?? `${c.latitude}, ${c.longitude}`}
        </span>
      );
    case 'PAYMENT_LINK':
      return (
        <a href={c.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
          💳 Payment link · {paiseToRupees(c.amount)}
        </a>
      );
    case 'TEMPLATE':
      return <p className="italic opacity-90">Template: {c.templateName}</p>;
    case 'VOICE':
      return <audio controls src={c.url} className="max-w-full" />;
    case 'VIDEO':
      return <video controls src={c.url} className="max-h-60 rounded-md" />;
    default:
      return <p className="italic opacity-80 flex items-center gap-1"><ImageIcon className="h-3.5 w-3.5" /> {c.type}</p>;
  }
}

function StatusTick({ message }: { message: Message }) {
  if (message.direction !== 'OUTBOUND') return null;
  if (message.status === 'FAILED') return <AlertCircle className="h-3.5 w-3.5 text-rose-300" />;
  if (message.status === 'READ') return <CheckCheck className="h-3.5 w-3.5 text-sky-200" />;
  if (message.status === 'DELIVERED') return <CheckCheck className="h-3.5 w-3.5 opacity-70" />;
  if (message.status === 'SENT') return <Check className="h-3.5 w-3.5 opacity-70" />;
  return <Clock className="h-3 w-3 opacity-70" />;
}

export function MessageBubble({ message }: { message: Message }) {
  // Internal team notes render centered, distinct from customer-facing messages.
  if (message.direction === 'INTERNAL') {
    return (
      <div className="flex justify-center">
        <div className="max-w-md rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-semibold">Internal note · </span>
          <MessageBody message={message} />
        </div>
      </div>
    );
  }

  const outbound = message.direction === 'OUTBOUND';

  return (
    <div className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
          outbound
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm border border-border bg-card text-card-foreground',
        )}
      >
        <MessageBody message={message} />
        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1 text-[10px]',
            outbound ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {message.sentByAi && (
            <span className="flex items-center gap-0.5">
              <Bot className="h-3 w-3" />
              {typeof message.aiConfidence === 'number' && `${Math.round(message.aiConfidence)}%`}
            </span>
          )}
          <span>{formatTimeIST(message.timestamp)}</span>
          <StatusTick message={message} />
        </div>
      </div>
    </div>
  );
}
