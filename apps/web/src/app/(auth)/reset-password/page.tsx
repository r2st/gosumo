'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';
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
      // The reset endpoint returns a fresh token pair — log the user straight in.
      tokenStore.setAccessToken(tokens.accessToken);
      tokenStore.setRefreshToken(tokens.refreshToken);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset your password. The link may have expired.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="animate-fade-in text-center">
        <h2 className="text-2xl font-bold tracking-tight">Invalid reset link</h2>
        <p className="mt-2 text-sm text-muted-foreground">This password reset link is missing or invalid.</p>
        <Link href="/forgot-password" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold tracking-tight">Set a new password</h2>
      <p className="mt-1 text-sm text-muted-foreground">Choose a strong password you don&apos;t use elsewhere.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            New password
          </label>
          <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="confirm" className="text-sm font-medium">
            Confirm password
          </label>
          <Input id="confirm" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="w-full" loading={submitting}>
          Reset password
        </Button>
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
