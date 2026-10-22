'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface Ticket {
  id: number;
  subject: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  urgency: 'immediate' | 'high' | 'normal' | 'low';
  customer: 'enterprise' | 'business' | 'standard';
  age: number;
}

const IMPACT_SCORE = { critical: 4, high: 3, medium: 2, low: 1 };
const URGENCY_SCORE = { immediate: 4, high: 3, normal: 2, low: 1 };
const CUSTOMER_MULTIPLIER = { enterprise: 1.5, business: 1.2, standard: 1.0 };
const AGE_BONUS = (hours: number) => Math.min(Math.floor(hours / 24) * 0.5, 3);

function priorityScore(t: Ticket): number {
  return (IMPACT_SCORE[t.impact] + URGENCY_SCORE[t.urgency]) * CUSTOMER_MULTIPLIER[t.customer] + AGE_BONUS(t.age);
}

function priorityLabel(score: number): { label: string; color: string } {
  if (score >= 10) return { label: 'P1 — Critical', color: 'var(--da-error)' };
  if (score >= 7) return { label: 'P2 — High', color: '#F59E0B' };
  if (score >= 4) return { label: 'P3 — Medium', color: 'var(--da-gold)' };
  return { label: 'P4 — Low', color: 'var(--da-success)' };
}

let nextId = 1;

export function TicketPriority() {
  const [tickets, setTickets] = useState<Ticket[]>([
    { id: nextId++, subject: 'Payment gateway down', impact: 'critical', urgency: 'immediate', customer: 'enterprise', age: 2 },
    { id: nextId++, subject: 'Cannot reset password', impact: 'medium', urgency: 'high', customer: 'standard', age: 12 },
    { id: nextId++, subject: 'Feature request: dark mode', impact: 'low', urgency: 'low', customer: 'business', age: 72 },
  ]);
  const [subject, setSubject] = useState('');
  const [impact, setImpact] = useState<Ticket['impact']>('medium');
  const [urgency, setUrgency] = useState<Ticket['urgency']>('normal');
  const [customer, setCustomer] = useState<Ticket['customer']>('standard');
  const [age, setAge] = useState(0);

  const addTicket = () => {
    if (!subject.trim()) return;
    setTickets([...tickets, { id: nextId++, subject, impact, urgency, customer, age }]);
    setSubject('');
  };

  const removeTicket = (id: number) => setTickets(tickets.filter((t) => t.id !== id));

  const sorted = [...tickets].sort((a, b) => priorityScore(b) - priorityScore(a));

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        Ticket Priority System
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Automatically prioritize support tickets based on impact, urgency, customer tier, and age. Uses a weighted scoring matrix.
      </p>

      <div className="p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] mb-6">
        <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Add Ticket</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-xs text-[var(--da-text-muted)] mb-1">Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Login page returning 500 error"
              className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs text-[var(--da-text-muted)] mb-1">Impact</label>
            <select value={impact} onChange={(e) => setImpact(e.target.value as Ticket['impact'])} className="w-full px-3 py-2 rounded-md text-sm">
              <option value="critical">Critical — service down</option>
              <option value="high">High — major feature broken</option>
              <option value="medium">Medium — workaround exists</option>
              <option value="low">Low — cosmetic / question</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--da-text-muted)] mb-1">Urgency</label>
            <select value={urgency} onChange={(e) => setUrgency(e.target.value as Ticket['urgency'])} className="w-full px-3 py-2 rounded-md text-sm">
              <option value="immediate">Immediate</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--da-text-muted)] mb-1">Customer Tier</label>
            <select value={customer} onChange={(e) => setCustomer(e.target.value as Ticket['customer'])} className="w-full px-3 py-2 rounded-md text-sm">
              <option value="enterprise">Enterprise (1.5x)</option>
              <option value="business">Business (1.2x)</option>
              <option value="standard">Standard (1.0x)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--da-text-muted)] mb-1">Age (hours)</label>
            <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} min={0}
              className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
        </div>
        <button onClick={addTicket} className="mt-4 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--da-gold)] text-[var(--da-bg)]">
          Add Ticket
        </button>
      </div>

      {sorted.length > 0 && (
        <div className="p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Priority Queue ({sorted.length} tickets)</h2>
          <div className="space-y-3">
            {sorted.map((t, i) => {
              const score = priorityScore(t);
              const { label, color } = priorityLabel(score);
              return (
                <div key={t.id} className="flex items-center gap-4 p-3 rounded-lg border border-[var(--da-border)] bg-[var(--da-bg)]">
                  <span className="text-lg font-bold text-[var(--da-text-muted)] w-8 text-center">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--da-text)] truncate">{t.subject}</p>
                    <p className="text-xs text-[var(--da-text-muted)]">
                      Impact: {t.impact} · Urgency: {t.urgency} · {t.customer} · {t.age}h old
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ color, backgroundColor: `${color}22` }}>
                      {label}
                    </span>
                    <p className="text-xs text-[var(--da-text-muted)] mt-1">Score: {score.toFixed(1)}</p>
                  </div>
                  <button onClick={() => removeTicket(t.id)} className="text-xs text-[var(--da-text-muted)] hover:text-[var(--da-error)]">×</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 p-5 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
        <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-3">How Priority Scoring Works</h2>
        <p className="text-xs text-[var(--da-text-muted)] leading-relaxed">
          Score = (Impact + Urgency) × Customer Multiplier + Age Bonus. Impact and urgency are rated 1-4.
          Enterprise customers get a 1.5× multiplier, business 1.2×. Tickets gain +0.5 per day of age (max +3).
          P1 (≥10) = Critical, P2 (≥7) = High, P3 (≥4) = Medium, P4 (&lt;4) = Low.
        </p>
      </div>

      <div className="mt-10">
        <ShareButtons title="Ticket Priority System" url="https://desk.doaide.com/tools/ticket-priority" />
      </div>
    </div>
  );
}
