import { Bot, Check, CheckCheck, Clock, FileText, ImageIcon, MapPin, AlertCircle, Mic } from 'lucide-react';
import type { Message } from '@/lib/types';
import { formatTimeIST } from '@/lib/format';
import { paiseToRupees } from '@/lib/format';
import { cn } from '@/lib/utils';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

interface AiConfidence {
  label: string;
  dot: string;
  text: string;
  score: number;
}

/**
 * Maps an AI message's confidence (0–100) to a routing badge, mirroring the
 * platform's confidence routing: ≥90 auto-executes, 70–89 drafts for review,
 * <70 escalates to a human. Confidence is read from `aiConfidence`, falling back
 * to `metadata.aiConfidence` / `metadata.confidence`. Returns null for
 * non-AI messages or when no confidence score is available.
 */
export function aiConfidenceBadge(message: Message): AiConfidence | null {
  if (!message.sentByAi) return null;
  const meta = message.metadata ?? {};
  const score =
    num(message.aiConfidence) ?? num(meta.aiConfidence) ?? num(meta.confidence);
  if (score == null) return null;

  if (score >= 90) return { label: 'Auto', dot: 'bg-emerald-500', text: 'text-emerald-400', score };
  if (score >= 70) return { label: 'Draft', dot: 'bg-amber-500', text: 'text-amber-400', score };
  return { label: 'Escalated', dot: 'bg-rose-500', text: 'text-rose-400', score };
}

function AiConfidenceBadge({ message }: { message: Message }) {
  const badge = aiConfidenceBadge(message);
  if (!badge) return null;
  return (
    <span
      className="mb-1 inline-flex items-center gap-1 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold"
      title={`AI confidence ${Math.round(badge.score)}%`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', badge.dot)} />
      <span className={badge.text}>{badge.label}</span>
    </span>
  );
}

/**
 * A voice/audio note: an inline player plus, when we have it, the AI
 * transcription beneath it. The transcript is enriched onto `metadata` by the
 * voice pipeline (the append-only message content is never mutated).
 */
function VoiceNote({ url, transcription }: { url?: string; transcription?: string }) {
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium opacity-80">
        <Mic className="h-3.5 w-3.5" /> Voice note
      </span>
      {url && <audio controls src={url} className="max-w-full" />}
      {transcription ? (
        <p className="whitespace-pre-wrap break-words border-l-2 border-current/20 pl-2 text-[13px] italic opacity-90">
          “{transcription}”
        </p>
      ) : (
        <p className="text-[11px] italic opacity-60">Transcribing…</p>
      )}
    </div>
  );
}

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
  const mimeType = str(content.mimeType) ?? '';
  // Voice notes arrive as VOICE/AUDIO, or (with the current WhatsApp adapter
  // mapping) as another type carrying an `audio/*` mime — treat all as voice.
  const transcription =
    str(content.transcription) ?? str((message.metadata ?? {}).transcription);
  if (type === 'VOICE' || type === 'AUDIO' || mimeType.startsWith('audio/')) {
    return <VoiceNote url={str(content.url)} transcription={transcription} />;
  }

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

/**
 * WhatsApp-style delivery ticks for outbound messages: one grey check on send,
 * two grey checks on delivery, two blue checks on read, an alert on failure.
 */
function StatusTick({ message }: { message: Message }) {
  if (message.direction !== 'OUTBOUND') return null;
  if (message.status === 'FAILED') return <AlertCircle className="h-3.5 w-3.5 text-rose-500" />;
  if (message.status === 'READ') return <CheckCheck className="h-3.5 w-3.5 text-sky-500" />;
  if (message.status === 'DELIVERED')
    return <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" />;
  if (message.status === 'SENT')
    return <Check className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Clock className="h-3 w-3 text-muted-foreground" />;
}

/**
 * Centered date pill separating messages by day in the thread ("Today",
 * "Yesterday", "3 Jul 2026"). The thread computes the grouping; this just renders.
 */
export function DayDivider({ label }: { label: string }) {
  if (!label) return null;
  return (
    <div className="flex justify-center py-1.5">
      <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  // Internal team notes render centered, distinct from customer-facing messages.
  if (message.direction === 'INTERNAL') {
    return (
      <div className="flex justify-center">
        <div className="max-w-md rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
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
          'relative max-w-[75%] px-3 py-1.5 text-sm shadow-sm',
          // WhatsApp bubbles: outbound light-green, inbound white/card. The
          // squared top corner on the tail side seats the little tail triangle.
          outbound
            ? 'rounded-2xl rounded-tr-md bg-[#005C4B] text-slate-50'
            : 'rounded-2xl rounded-tl-md border border-border bg-card text-card-foreground',
        )}
      >
        {/* Tail: a small rotated square peeking out of the top corner. */}
        <span
          aria-hidden
          className={cn(
            'absolute top-0 h-3 w-3 rotate-45',
            outbound
              ? '-right-1 bg-[#005C4B]'
              : '-left-1 border-l border-t border-border bg-card',
          )}
        />
        {message.sentByAi && (
          <div className="flex">
            <AiConfidenceBadge message={message} />
          </div>
        )}
        <MessageBody message={message} />
        <div
          className={cn(
            'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
            outbound ? 'text-slate-200/70' : 'text-muted-foreground',
          )}
        >
          {message.sentByAi && (
            <span className="flex items-center gap-0.5">
              <Bot className="h-3 w-3" />
            </span>
          )}
          <span>{formatTimeIST(message.timestamp)}</span>
          <StatusTick message={message} />
        </div>
      </div>
    </div>
  );
}
