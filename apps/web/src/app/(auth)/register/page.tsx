'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
    <div className="animate-fade-in">
      <h2 className="text-2xl font-bold tracking-tight">Create your workspace</h2>
      <p className="mt-1 text-sm text-muted-foreground">Start handling customers with AI in minutes.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="businessName" className="text-sm font-medium">
            Business name
          </label>
          <Input id="businessName" required value={form.businessName} onChange={update('businessName')} placeholder="Sharma Salon & Spa" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium">
            Your name
          </label>
          <Input id="name" required value={form.name} onChange={update('name')} placeholder="Priya Sharma" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input id="email" type="email" required value={form.email} onChange={update('email')} placeholder="you@business.com" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone
            </label>
            <Input id="phone" type="tel" value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <Input id="password" type="password" required minLength={8} value={form.password} onChange={update('password')} placeholder="At least 8 characters" />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" className="w-full" loading={submitting}>
          Create account
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        OR
        <div className="h-px flex-1 bg-border" />
      </div>

      <GoogleButton label="Sign up with Google" />

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
