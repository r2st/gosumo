'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const CATEGORIES = [
  {
    id: 'bug',
    label: 'Bug Report',
    subject: '[BUG] {{summary}}',
    fields: ['Steps to Reproduce', 'Expected Behavior', 'Actual Behavior', 'Browser / OS', 'Screenshots'],
    priority: 'High',
    description: 'Describe the bug in detail. Include error messages if any.',
  },
  {
    id: 'feature',
    label: 'Feature Request',
    subject: '[FEATURE] {{summary}}',
    fields: ['Problem Statement', 'Proposed Solution', 'Use Case', 'Alternatives Considered'],
    priority: 'Medium',
    description: 'Describe the feature you would like and why it would be valuable.',
  },
  {
    id: 'inquiry',
    label: 'General Inquiry',
    subject: '[INQUIRY] {{summary}}',
    fields: ['Question', 'Context', 'Preferred Response Method'],
    priority: 'Low',
    description: 'Provide details about your inquiry.',
  },
  {
    id: 'billing',
    label: 'Billing Issue',
    subject: '[BILLING] {{summary}}',
    fields: ['Account / Invoice Number', 'Issue Description', 'Amount in Question', 'Date of Transaction'],
    priority: 'High',
    description: 'Describe the billing issue. Include relevant transaction details.',
  },
  {
    id: 'technical',
    label: 'Technical Support',
    subject: '[SUPPORT] {{summary}}',
    fields: ['Issue Description', 'Error Messages', 'Steps Already Tried', 'System Information', 'Urgency Level'],
    priority: 'Medium',
    description: 'Describe the technical issue you are experiencing.',
  },
] as const;

export function TicketTemplateGenerator() {
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const category = CATEGORIES.find((c) => c.id === selected);

  const template = category
    ? `Subject: ${category.subject}\nPriority: ${category.priority}\n\n${category.description}\n\nRequired Information:\n${category.fields.map((f) => `- ${f}: `).join('\n')}\n\n---\nGenerated with GoSumo Realty — https://gosumo.aiknol.com/tools/ticket-template-generator`
    : '';

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        Ticket Template Generator
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Choose a ticket category and get a ready-to-use template with the right fields and priority — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-4">Select Category</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelected(cat.id)}
                className={`p-3 rounded-lg border text-sm font-medium transition-all text-left ${
                  selected === cat.id
                    ? 'border-[var(--doaide-gold)] bg-[var(--doaide-gold)]/10 text-[var(--doaide-gold)]'
                    : 'border-[var(--doaide-border)] text-[var(--doaide-text)] hover:border-[var(--doaide-gold)]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {category && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
                <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Category</p>
                <p className="text-sm font-semibold text-[var(--doaide-text)]">{category.label}</p>
              </div>
              <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
                <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Priority</p>
                <p className={`text-sm font-semibold ${category.priority === 'High' ? 'text-[var(--doaide-error)]' : category.priority === 'Medium' ? 'text-[var(--doaide-warning)]' : 'text-[var(--doaide-success)]'}`}>
                  {category.priority}
                </p>
              </div>
              <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
                <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Fields</p>
                <p className="text-sm font-semibold text-[var(--doaide-text)]">{category.fields.length}</p>
              </div>
            </div>

            <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)]">Template Preview</h2>
                <button
                  onClick={copyTemplate}
                  className="px-4 py-1.5 rounded-lg bg-[var(--doaide-gold)] text-black text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  {copied ? 'Copied!' : 'Copy Template'}
                </button>
              </div>
              <pre className="text-sm text-[var(--doaide-text)] whitespace-pre-wrap font-mono bg-[var(--doaide-bg)] p-4 rounded-lg overflow-x-auto">
                {template}
              </pre>
            </div>

            <ShareButtons url="https://gosumo.aiknol.com/tools/ticket-template-generator" title="Ticket Template Generator — Free tool by GoSumo Realty" />

            <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] text-center">
              <p className="text-sm text-[var(--doaide-text-secondary)] mb-3">Want to save your templates and track tickets over time?</p>
              <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--doaide-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
