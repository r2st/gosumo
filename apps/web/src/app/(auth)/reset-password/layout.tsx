import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Choose a new password',
  description: 'Set a new password for your DoAide Desk account.',
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
