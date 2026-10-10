'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { friendlyError } from '@/lib/errors';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(friendlyError(err, 'Unable to send the reset link. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="doaide-auth-fade-up" style={{ textAlign: 'center' }}>
        <div className="doaide-auth-icon-circle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /><path d="m16 19 2 2 4-4" /></svg>
        </div>
        <h2 className="doaide-auth-heading">Check your email</h2>
        <p className="doaide-auth-hint" style={{ marginTop: '8px' }}>
          If an account exists for <strong style={{ color: '#E5E7EB' }}>{email}</strong>, we&apos;ve sent a password reset link.
        </p>
        <Link href="/login" className="doaide-auth-back-link">
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="doaide-auth-fade-up">
      <h2 className="doaide-auth-heading">Reset your password</h2>
      <p className="doaide-auth-hint">Enter your email and we&apos;ll send you a reset link.</p>

      <form onSubmit={onSubmit} className="doaide-auth-form">
        <div className="doaide-auth-field">
          <label htmlFor="email" className="doaide-auth-label">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" className="doaide-auth-input" />
        </div>

        {error && <p className="doaide-auth-error">{error}</p>}

        <button type="submit" disabled={submitting} className="doaide-auth-button">
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <Link href="/login" className="doaide-auth-back-link">
        ← Back to sign in
      </Link>
    </div>
  );
}
