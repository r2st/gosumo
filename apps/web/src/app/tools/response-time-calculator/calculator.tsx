'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface Entry { minutes: number }

export function ResponseTimeCalculator() {
  const [entries, setEntries] = useState<Entry[]>([{ minutes: 5 }, { minutes: 12 }, { minutes: 3 }]);
  const [slaTarget, setSlaTarget] = useState(15);
  const [newVal, setNewVal] = useState('');

  const addEntry = () => {
    const v = parseFloat(newVal);
    if (!isNaN(v) && v >= 0) {
      setEntries([...entries, { minutes: v }]);
      setNewVal('');
    }
  };

  const removeEntry = (i: number) => setEntries(entries.filter((_, idx) => idx !== i));

  const avg = entries.length ? entries.reduce((s, e) => s + e.minutes, 0) / entries.length : 0;
  const withinSla = entries.length ? entries.filter((e) => e.minutes <= slaTarget).length : 0;
  const slaCompliance = entries.length ? (withinSla / entries.length) * 100 : 0;
  const fastest = entries.length ? Math.min(...entries.map((e) => e.minutes)) : 0;
  const slowest = entries.length ? Math.max(...entries.map((e) => e.minutes)) : 0;

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        Response Time Calculator
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Calculate average support response times and SLA compliance across your team.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">SLA Target (minutes)</label>
          <input
            type="number"
            min={1}
            value={slaTarget}
            onChange={(e) => setSlaTarget(Number(e.target.value) || 1)}
            className="w-32 px-3 py-2 rounded-md text-sm"
          />
        </div>

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-3">Response Times (minutes)</h2>
          <div className="flex flex-wrap gap-2 mb-4">
            {entries.map((e, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm bg-[var(--doaide-gold-bg)] text-[var(--doaide-gold)]">
                {e.minutes}m
                <button onClick={() => removeEntry(i)} className="ml-1 hover:text-[var(--doaide-error)]" aria-label={`Remove ${e.minutes} minutes`}>&times;</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              min={0}
              step="any"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEntry()}
              placeholder="Add response time"
              className="flex-1 px-3 py-2 rounded-md text-sm"
            />
            <button onClick={addEntry} className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)]">Add</button>
          </div>
        </div>

        {entries.length > 0 && (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Average Response" value={`${avg.toFixed(1)} min`} />
            <Stat label="SLA Compliance" value={`${slaCompliance.toFixed(1)}%`} highlight={slaCompliance >= 90} />
            <Stat label="Fastest" value={`${fastest} min`} />
            <Stat label="Slowest" value={`${slowest} min`} />
          </div>
        )}

        <ShareButtons url="https://desk.doaide.com/tools/response-time-calculator" title="Response Time Calculator — Free tool by DoAide Desk" />
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="p-4 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
      <p className="text-xs text-[var(--doaide-text-muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${highlight ? 'text-[var(--doaide-success)]' : 'text-[var(--doaide-gold)]'}`}>{value}</p>
    </div>
  );
}
