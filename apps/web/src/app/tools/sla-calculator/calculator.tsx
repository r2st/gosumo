'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

export function SlaCalculator() {
  const [uptime, setUptime] = useState('99.9');
  const [responseTarget, setResponseTarget] = useState('4');
  const [ticketsPerMonth, setTicketsPerMonth] = useState('500');

  const uptimeVal = parseFloat(uptime) || 0;
  const responseVal = parseFloat(responseTarget) || 0;
  const ticketsVal = parseInt(ticketsPerMonth, 10) || 0;

  const downtimePercent = 100 - uptimeVal;
  const minutesPerMonth = 30 * 24 * 60;
  const minutesPerYear = 365 * 24 * 60;
  const allowedDowntimeMonth = (downtimePercent / 100) * minutesPerMonth;
  const allowedDowntimeYear = (downtimePercent / 100) * minutesPerYear;

  const ticketsPerDay = ticketsVal / 30;
  const ticketsPerAgent = 20;
  const agentsNeeded = Math.ceil(ticketsPerDay / ticketsPerAgent);

  const responseCapacity = responseVal > 0 ? Math.floor((8 * 60) / (responseVal * 60)) : 0;

  const fmt = (mins: number) => {
    if (mins < 60) return `${mins.toFixed(1)} min`;
    if (mins < 1440) return `${(mins / 60).toFixed(1)} hrs`;
    return `${(mins / 1440).toFixed(1)} days`;
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        SLA Calculator
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Enter your SLA targets to calculate allowed downtime, required response capacity, and minimum agents needed — no sign-up required.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-4">SLA Targets</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--doaide-text)] w-44">Target Uptime (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={uptime}
                onChange={(e) => setUptime(e.target.value)}
                className="w-28 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--doaide-text)] w-44">Response Time Target (hrs)</label>
              <input
                type="number"
                min={0}
                step="0.5"
                value={responseTarget}
                onChange={(e) => setResponseTarget(e.target.value)}
                className="w-28 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm text-[var(--doaide-text)] w-44">Tickets per Month</label>
              <input
                type="number"
                min={0}
                value={ticketsPerMonth}
                onChange={(e) => setTicketsPerMonth(e.target.value)}
                className="w-28 px-3 py-2 rounded-md text-sm text-center"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
            <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Downtime / Month</p>
            <p className="text-xl font-bold text-[var(--doaide-error)]">{fmt(allowedDowntimeMonth)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
            <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Downtime / Year</p>
            <p className="text-xl font-bold text-[var(--doaide-warning)]">{fmt(allowedDowntimeYear)}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
            <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Responses / Shift</p>
            <p className="text-xl font-bold text-[var(--doaide-gold)]">{responseCapacity}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
            <p className="text-xs text-[var(--doaide-text-muted)] mb-1">Agents Needed</p>
            <p className="text-xl font-bold text-[var(--doaide-success)]">{agentsNeeded}</p>
          </div>
        </div>

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-3">Common SLA Tiers</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--doaide-border)]">
                  <th className="text-left py-2 text-[var(--doaide-text-muted)]">Tier</th>
                  <th className="text-left py-2 text-[var(--doaide-text-muted)]">Uptime</th>
                  <th className="text-left py-2 text-[var(--doaide-text-muted)]">Downtime / Year</th>
                </tr>
              </thead>
              <tbody className="text-[var(--doaide-text)]">
                {[
                  { tier: 'Two nines', uptime: '99%', downtime: '3.65 days' },
                  { tier: 'Three nines', uptime: '99.9%', downtime: '8.77 hrs' },
                  { tier: 'Four nines', uptime: '99.99%', downtime: '52.6 min' },
                  { tier: 'Five nines', uptime: '99.999%', downtime: '5.26 min' },
                ].map((row) => (
                  <tr key={row.tier} className="border-b border-[var(--doaide-border)]">
                    <td className="py-2">{row.tier}</td>
                    <td className="py-2 font-mono">{row.uptime}</td>
                    <td className="py-2 font-mono">{row.downtime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <ShareButtons url="https://gosumo.aiknol.com/tools/sla-calculator" title="SLA Calculator — Free tool by GoSumo Realty" />

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] text-center">
          <p className="text-sm text-[var(--doaide-text-secondary)] mb-3">Want to track SLA compliance automatically?</p>
          <a href="/register" className="inline-block px-6 py-2.5 rounded-lg bg-[var(--doaide-gold)] text-black font-medium text-sm hover:opacity-90 transition-opacity">Sign up free</a>
        </div>
      </div>
    </div>
  );
}
