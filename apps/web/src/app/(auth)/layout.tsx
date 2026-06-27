import { Bot, ShieldCheck, Sparkles } from 'lucide-react';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <Logo className="[&_span]:text-sidebar-foreground" />
        <div className="space-y-6">
          <h1 className="text-3xl font-bold leading-tight">
            One AI inbox for every customer conversation.
          </h1>
          <p className="max-w-md text-sidebar-muted">
            WhatsApp, Instagram, SMS, Web Chat and Email — handled by AI, with your team in the loop
            exactly when it matters.
          </p>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center gap-3">
              <Bot className="h-5 w-5 text-primary" />
              AI drafts replies and you approve in one click
            </li>
            <li className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-primary" />
              Confidence-based routing keeps quality high
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Multi-tenant, secure, built for India
            </li>
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">© {new Date().getFullYear()} GoSumo. All rights reserved.</p>
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
