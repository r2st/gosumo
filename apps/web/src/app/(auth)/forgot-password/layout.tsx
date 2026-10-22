import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reset your password',
  description: 'Request a password reset link for your DoAide Desk account.',
  robots: { index: false, follow: true },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
