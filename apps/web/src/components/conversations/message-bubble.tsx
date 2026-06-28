import { Bot, Check, CheckCheck, Clock, FileText, ImageIcon, MapPin, AlertCircle } from 'lucide-react';
import type { Message } from '@/lib/types';
import { formatTimeIST } from '@/lib/format';
import { paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function MessageBody({ message }: { message: Message }) {
  // The stored `content` payload is polymorphic JSONB and isn't always the
  // discriminated union the type claims: text messages may arrive as a plain
  // `{ "text": "..." }` with no `type`, or with a lower-cased type. Read it
  // defensively and fall back to the denormalized `text_content` column so a
  // text message never renders as a broken media placeholder.
  const content = (message.content ?? {}) as Record<string, unknown>;
  const textContent = (message as Message & { text_content?: string }).text_content;
  const type = (str(content.type) ?? '').toUpperCase();
  const text = str(content.text) ?? textContent;

  switch (type) {
    case 'IMAGE': {
      const url = str(content.url);
      const caption = str(content.caption);
      if (url) {
        return (
          <div className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={caption ?? 'image'} className="max-h-60 rounded-md object-cover" />
            {caption && <p className="break-words">{caption}</p>}
          </div>
        );
      }
      break;
    }
    case 'DOCUMENT': {
      const url = str(content.url);
      if (url) {
        return (
          <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
            <FileText className="h-4 w-4" /> {str(content.filename) ?? 'Document'}
          </a>
        );
      }
      break;
    }
    case 'LOCATION': {
      const name = str(content.name);
      const lat = num(content.latitude);
      const lng = num(content.longitude);
      return (
        <span className="flex items-center gap-1">
          <MapPin className="h-4 w-4" /> {name ?? `${lat ?? '?'}, ${lng ?? '?'}`}
        </span>
      );
    }
    case 'PAYMENT_LINK': {
      const url = str(content.url);
      return (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
          💳 Payment link · {paiseToRupees(num(content.amount) ?? 0)}
        </a>
      );
    }
    case 'TEMPLATE':
      return <p className="italic opacity-90">Template: {str(content.templateName) ?? ''}</p>;
    case 'VOICE': {
      const url = str(content.url);
      if (url) return <audio controls src={url} className="max-w-full" />;
      break;
    }
    case 'VIDEO': {
      const url = str(content.url);
      if (url) return <video controls src={url} className="max-h-60 rounded-md" />;
      break;
    }
    default:
      break;
  }

  // TEXT, an unknown type that still carries text, or media missing its URL:
  // show the text if we have any, otherwise a minimal placeholder.
  if (text) return <p className="whitespace-pre-wrap break-words">{text}</p>;
  return (
    <p className="italic opacity-80 flex items-center gap-1">
      <ImageIcon className="h-3.5 w-3.5" /> {type || 'Unsupported message'}
    </p>
  );
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
