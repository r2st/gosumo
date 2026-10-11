'use client';

import { useState, useCallback } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { friendlyError } from '@/lib/errors';

type FeedbackType = 'bug' | 'feature' | 'general';

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Bug Report',
  feature: 'Feature Request',
  general: 'General Feedback',
};

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>('general');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setType('general');
    setMessage('');
    setEmail('');
    setError(null);
    setSubmitted(false);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    if (submitted) reset();
  }, [submitted, reset]);

  const handleSubmit = useCallback(async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          message: message.trim(),
          email: email.trim() || undefined,
          url: window.location.href,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed (${res.status})`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(friendlyError(err, 'Unable to send your feedback. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }, [type, message, email]);

  return (
    <>
      <button
        onClick={() => { setOpen(true); if (submitted) reset(); }}
        className="fixed bottom-4 left-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Send feedback"
      >
        <MessageSquarePlus className="h-5 w-5" />
      </button>

      <Modal
        open={open}
        onClose={handleClose}
        title="Send Feedback"
        description="Help us improve DoAide Desk"
        footer={
          submitted ? (
            <Button variant="secondary" onClick={handleClose}>Close</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={handleClose}>Cancel</Button>
              <Button onClick={handleSubmit} loading={submitting} disabled={!message.trim()}>
                Send
              </Button>
            </>
          )
        }
      >
        {submitted ? (
          <p className="py-4 text-center text-sm text-muted-foreground" role="status">
            Thanks for your feedback!
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="Type">
              <div className="flex gap-2" role="radiogroup" aria-label="Feedback type">
                {(Object.keys(TYPE_LABELS) as FeedbackType[]).map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={type === t}
                    onClick={() => setType(t)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      type === t
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Message">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us what's on your mind..."
                rows={4}
                required
              />
            </Field>

            <Field label="Email (optional)" hint="In case we need to follow up">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}
