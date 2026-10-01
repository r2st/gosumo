import { Globe, Instagram, Mail, MessageCircle, MessageSquare, Phone } from 'lucide-react';
import type { ChannelType } from '@/lib/types';
import { cn } from '@/lib/utils';

const CONFIG: Record<ChannelType, { icon: typeof Globe; label: string; className: string }> = {
  WHATSAPP: { icon: MessageCircle, label: 'WhatsApp', className: 'text-emerald-400 bg-emerald-500/15' },
  INSTAGRAM: { icon: Instagram, label: 'Instagram', className: 'text-pink-400 bg-pink-500/15' },
  SMS: { icon: Phone, label: 'SMS', className: 'text-sky-400 bg-sky-500/15' },
  WEB_CHAT: { icon: Globe, label: 'Web Chat', className: 'text-violet-400 bg-violet-500/15' },
  EMAIL: { icon: Mail, label: 'Email', className: 'text-amber-400 bg-amber-500/15' },
};

export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  const cfg = CONFIG[channel] ?? {
    icon: MessageSquare,
    label: channel,
    className: 'text-muted-foreground bg-muted',
  };
  const Icon = cfg.icon;
  return (
    <span
      title={cfg.label}
      className={cn('flex h-6 w-6 items-center justify-center rounded-md', cfg.className, className)}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function channelLabel(channel: ChannelType): string {
  return CONFIG[channel]?.label ?? channel;
}
