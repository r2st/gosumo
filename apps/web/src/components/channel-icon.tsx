import { Globe, Instagram, Mail, MessageCircle, MessageSquare, Phone } from 'lucide-react';
import type { ChannelType } from '@/lib/types';
import { cn } from '@/lib/utils';

const CONFIG: Record<ChannelType, { icon: typeof Globe; label: string; className: string }> = {
  WHATSAPP: { icon: MessageCircle, label: 'WhatsApp', className: 'text-emerald-600 bg-emerald-50' },
  INSTAGRAM: { icon: Instagram, label: 'Instagram', className: 'text-pink-600 bg-pink-50' },
  SMS: { icon: Phone, label: 'SMS', className: 'text-sky-600 bg-sky-50' },
  WEB_CHAT: { icon: Globe, label: 'Web Chat', className: 'text-violet-600 bg-violet-50' },
  EMAIL: { icon: Mail, label: 'Email', className: 'text-amber-600 bg-amber-50' },
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
