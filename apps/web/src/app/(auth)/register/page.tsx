'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GoogleButton } from '@/components/google-button';
import { useAuth } from '@/providers/auth-provider';
import { ApiError } from '@/lib/api-client';

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [form, setForm] = useState({ businessName: '', name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await register({
        businessName: form.businessName,
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
      });
      router.replace(ok ? '/dashboard' : '/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="doaide-auth-fade-up">
      <form onSubmit={onSubmit} className="doaide-auth-form">
        <div className="doaide-auth-field">
          <label htmlFor="businessName" className="doaide-auth-label">Business name</label>
          <input id="businessName" required value={form.businessName} onChange={update('businessName')} placeholder="Sharma Realty" className="doaide-auth-input" />
        </div>
        <div className="doaide-auth-field">
          <label htmlFor="name" className="doaide-auth-label">Your name</label>
          <input id="name" required value={form.name} onChange={update('name')} placeholder="Priya Sharma" className="doaide-auth-input" />
        </div>
        <div className="doaide-auth-row">
          <div className="doaide-auth-field">
            <label htmlFor="email" className="doaide-auth-label">Email</label>
            <input id="email" type="email" required value={form.email} onChange={update('email')} placeholder="you@business.com" className="doaide-auth-input" />
          </div>
          <div className="doaide-auth-field">
            <label htmlFor="phone" className="doaide-auth-label">Phone</label>
            <input id="phone" type="tel" value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" className="doaide-auth-input" />
          </div>
        </div>
        <div className="doaide-auth-field">
          <label htmlFor="password" className="doaide-auth-label">Password</label>
          <input id="password" type="password" required minLength={8} value={form.password} onChange={update('password')} placeholder="At least 8 characters" className="doaide-auth-input" />
        </div>

        {error && <p className="doaide-auth-error">{error}</p>}

        <button type="submit" disabled={submitting} className="doaide-auth-button">
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <div className="doaide-auth-divider">
        <span>OR</span>
      </div>

      <GoogleButton label="Sign up with Google" />

      <p className="doaide-auth-switch">
        Already have an account?{' '}
        <Link href="/login" className="doaide-auth-link">Sign in</Link>
      </p>
    </div>
  );
}
