'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { GoogleButton } from '@/components/google-button';
import { GitHubButton } from '@/components/github-button';
import { MicrosoftButton } from '@/components/microsoft-button';
import { useAuth } from '@/providers/auth-provider';
import { ApiError } from '@/lib/api-client';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await login(email, password);
      if (ok) {
        router.replace(params?.get('next') ?? '/dashboard');
      } else {
        setError('Two-factor authentication is required for this account.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="doaide-auth-fade-up">
      <form onSubmit={onSubmit} className="doaide-auth-form">
        <div className="doaide-auth-field">
          <label htmlFor="email" className="doaide-auth-label">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com"
            className="doaide-auth-input"
          />
        </div>
        <div className="doaide-auth-field">
          <div className="doaide-auth-label-row">
            <label htmlFor="password" className="doaide-auth-label">Password</label>
            <Link href="/forgot-password" className="doaide-auth-link-small">Forgot?</Link>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="doaide-auth-input"
          />
        </div>

        {error && <p className="doaide-auth-error">{error}</p>}

        <button type="submit" disabled={submitting} className="doaide-auth-button">
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="doaide-auth-divider">
        <span>OR</span>
      </div>

      <div className="flex flex-col gap-2">
        <GoogleButton />
        <GitHubButton />
        <MicrosoftButton />
      </div>

      <p className="doaide-auth-switch">
        New to DoAide Desk?{' '}
        <Link href="/register" className="doaide-auth-link">Create a business account</Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
