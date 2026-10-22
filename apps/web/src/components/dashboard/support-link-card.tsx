'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Copy, MessageCircle, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChannels } from '@/hooks/use-settings';
import {
  buildWhatsAppLink,
  buildWhatsAppShareLink,
  supportLinkMessage,
} from '@/lib/whatsapp-link';

const SITE = 'https://desk.doaide.com';

/** The public, login-free ticket page for one web-chat widget. */
export function supportLinkFor(widgetId: string): string {
  return `${SITE}/support?w=${encodeURIComponent(widgetId)}`;
}

/**
 * Gives operators the link their customers use to raise a ticket without an
 * account, and two ways to put it in front of them on WhatsApp: a share sheet
 * (status, groups, any chat) or a direct message to one number.
 */
export function SupportLinkCard() {
  const channelsQ = useChannels();
  const [phone, setPhone] = useState('');
  const [copied, setCopied] = useState(false);

  const webChat = channelsQ.data?.data.find((c) => c.type === 'WEB_CHAT' && c.status === 'CONNECTED')
    ?? channelsQ.data?.data.find((c) => c.type === 'WEB_CHAT');

  if (channelsQ.isLoading || channelsQ.isError) return null;

  if (!webChat) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Let customers raise tickets without signing up</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Connect a Web Chat channel to get a shareable support link you can send on WhatsApp.{' '}
          <Link href="/settings/channels" className="font-medium text-primary underline-offset-2 hover:underline">
            Connect Web Chat
          </Link>
        </CardContent>
      </Card>
    );
  }

  const link = supportLinkFor(webChat.id);
  const message = supportLinkMessage(link);
  const direct = buildWhatsAppLink(phone, message);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard API unavailable */
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your support link</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Customers open this link and raise a ticket — no account needed. Tickets arrive in Conversations.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input readOnly value={link} aria-label="Support link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="outline" onClick={copy}>
            <Copy className="h-4 w-4" />
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <a
            href={buildWhatsAppShareLink(message)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 max-sm:h-12"
          >
            <MessageCircle className="h-4 w-4" />
            Share on WhatsApp
          </a>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (direct) window.open(direct, '_blank', 'noopener');
          }}
        >
          <Input
            type="tel"
            inputMode="tel"
            placeholder="Customer WhatsApp number, e.g. +91 98765 43210"
            aria-label="Customer WhatsApp number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!direct}>
            <Send className="h-4 w-4" />
            Send link
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
