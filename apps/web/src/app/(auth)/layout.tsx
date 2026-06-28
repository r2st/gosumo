import { Bot, ShieldCheck, Sparkles } from 'lucide-react';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 p-12 text-white lg:flex">
        {/* Soft glow accents */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-violet-400/20 blur-3xl" />

        <div className="relative">
          <Logo className="[&_span]:text-white" />
        </div>
        <div className="relative space-y-6">
          <h1 className="text-3xl font-bold leading-tight tracking-tight">
            One AI inbox for every customer conversation.
          </h1>
          <p className="max-w-md text-indigo-100">
            WhatsApp, Instagram, SMS, Web Chat and Email — handled by AI, with your team in the loop
            exactly when it matters.
          </p>
          <ul className="space-y-3 text-sm text-indigo-50">
            <li className="flex items-center gap-3">
              <Bot className="h-5 w-5 text-indigo-200" />
              AI drafts replies and you approve in one click
            </li>
            <li className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-indigo-200" />
              Confidence-based routing keeps quality high
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-indigo-200" />
              Multi-tenant, secure, built for India
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-indigo-200">© {new Date().getFullYear()} GoSumo. All rights reserved.</p>
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
