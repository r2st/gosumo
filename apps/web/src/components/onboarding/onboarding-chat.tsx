'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/states';
import { useOnboardingChat } from '@/hooks/use-onboarding';
import type { OnboardingChatMessage, OnboardingStepId } from '@/lib/onboarding-types';

/**
 * OnboardingChat — the contextual AI digital robot sidebar. It knows the current
 * wizard step and answers setup questions ("What WhatsApp number format do I
 * need?"). Suggested questions for the active step are shown as quick chips.
 */
export function OnboardingChat({
  step,
  stepTitle,
  suggestedQuestions,
}: {
  step: OnboardingStepId;
  stepTitle: string;
  suggestedQuestions: string[];
}) {
  const [messages, setMessages] = useState<OnboardingChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chips, setChips] = useState<string[]>(suggestedQuestions);
  const chat = useOnboardingChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset suggested chips when the step changes (messages persist across steps).
  useEffect(() => {
    setChips(suggestedQuestions);
  }, [suggestedQuestions, step]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, chat.isPending]);

  const send = (text: string) => {
    const message = text.trim();
    if (!message || chat.isPending) return;
    const history = messages.slice(-6);
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setInput('');
    chat.mutate(
      { message, step, history },
      {
        onSuccess: (res) => {
          setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
          setChips(res.suggestedQuestions ?? []);
        },
        onError: () => {
          setMessages((m) => [
            ...m,
            {
              role: 'assistant',
              content: "I couldn't reach the digital robot just now. Please try again in a moment.",
            },
          ]);
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col bg-muted/30">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">Setup Digital Robot</p>
          <p className="truncate text-xs text-muted-foreground">Help with: {stepTitle}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 scrollbar-thin">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card p-3 text-sm text-muted-foreground">
            Ask me anything about setting up DoAide Desk — connecting channels, WhatsApp verification, AI settings, and more.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
                m.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm border border-border bg-card text-foreground',
              )}
            >
              {m.content}
            </div>
          </div>
        ))}
        {chat.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="h-3.5 w-3.5" /> Thinking…
          </div>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
          {chips.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => send(q)}
              disabled={chat.isPending}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-border p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the digital robot…"
          className="h-9 flex-1 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="icon" disabled={!input.trim() || chat.isPending} aria-label="Send">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
