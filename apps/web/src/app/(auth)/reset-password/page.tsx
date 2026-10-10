'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api-client';
import { friendlyError } from '@/lib/errors';
import { tokenStore } from '@/lib/token-store';

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const tokens = await api.auth.resetPassword(token, password);
      tokenStore.setAccessToken(tokens.accessToken);
      tokenStore.setRefreshToken(tokens.refreshToken);
      router.replace('/dashboard');
    } catch (err) {
      setError(friendlyError(err, 'Unable to reset your password. The link may have expired.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="doaide-auth-fade-up" style={{ textAlign: 'center' }}>
        <div className="doaide-auth-icon-circle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
        </div>
        <h2 className="doaide-auth-heading" style={{ textAlign: 'center' }}>Invalid reset link</h2>
        <p className="doaide-auth-hint" style={{ textAlign: 'center', marginTop: '8px' }}>
          This password reset link is missing or invalid.
        </p>
        <Link href="/forgot-password" className="doaide-auth-back-link">
          ← Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="doaide-auth-fade-up">
      <h2 className="doaide-auth-heading">Set a new password</h2>
      <p className="doaide-auth-hint">Choose a strong password you don&apos;t use elsewhere.</p>

      <form onSubmit={onSubmit} className="doaide-auth-form">
        <div className="doaide-auth-field">
          <label htmlFor="password" className="doaide-auth-label">New password</label>
          <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className="doaide-auth-input" />
        </div>
        <div className="doaide-auth-field">
          <label htmlFor="confirm" className="doaide-auth-label">Confirm password</label>
          <input id="confirm" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" className="doaide-auth-input" />
        </div>

        {error && <p className="doaide-auth-error">{error}</p>}

        <button type="submit" disabled={submitting} className="doaide-auth-button">
          {submitting ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
