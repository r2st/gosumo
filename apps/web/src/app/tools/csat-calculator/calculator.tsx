'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const RATINGS = ['Very Unsatisfied', 'Unsatisfied', 'Neutral', 'Satisfied', 'Very Satisfied'] as const;

export function CsatCalculator() {
  const [counts, setCounts] = useState([2, 5, 15, 45, 33]);

  const total = counts.reduce((s, c) => s + c, 0);
  const satisfied = counts[3] + counts[4];
  const csat = total > 0 ? (satisfied / total) * 100 : 0;
  const weightedSum = counts.reduce((s, c, i) => s + c * (i + 1), 0);
  const avgRating = total > 0 ? weightedSum / total : 0;

  const update = (idx: number, val: string) => {
    const v = parseInt(val, 10);
    if (isNaN(v) || v < 0) return;
    setCounts(counts.map((c, i) => (i === idx ? v : c)));
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
        CSAT Calculator
      </h1>
      <p className="text-[var(--da-text-secondary)] mb-8">
        Calculate your Customer Satisfaction Score from survey responses. CSAT = (Satisfied + Very Satisfied) / Total Responses &times; 100.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
          <h2 className="text-sm font-medium text-[var(--da-text-secondary)] mb-4">Survey Responses</h2>
          <div className="space-y-3">
            {RATINGS.map((label, i) => (
              <div key={label} className="flex items-center gap-4">
                <label className="text-sm text-[var(--da-text)] w-36">{label}</label>
                <input
                  type="number"
                  min={0}
                  value={counts[i]}
                  onChange={(e) => update(i, e.target.value)}
                  className="w-24 px-3 py-2 rounded-md text-sm text-center"
                />
                {total > 0 && (
                  <div className="flex-1 h-4 rounded bg-[var(--da-bg)] overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${(counts[i] / total) * 100}%`,
                        backgroundColor: i >= 3 ? 'var(--da-success)' : i === 2 ? 'var(--da-warning)' : 'var(--da-error)',
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">CSAT Score</p>
            <p className={`text-xl font-bold ${csat >= 80 ? 'text-[var(--da-success)]' : csat >= 60 ? 'text-[var(--da-warning)]' : 'text-[var(--da-error)]'}`}>
              {csat.toFixed(1)}%
            </p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Avg Rating</p>
            <p className="text-xl font-bold text-[var(--da-gold)]">{avgRating.toFixed(2)}/5</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Total Responses</p>
            <p className="text-xl font-bold text-[var(--da-text)]">{total}</p>
          </div>
          <div className="p-4 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)]">
            <p className="text-xs text-[var(--da-text-muted)] mb-1">Satisfied</p>
            <p className="text-xl font-bold text-[var(--da-success)]">{satisfied}</p>
          </div>
        </div>

        <ShareButtons url="https://desk.doaide.com/tools/csat-calculator" title="CSAT Calculator — Free tool by DoAide Desk" />
      </div>
    </div>
  );
}
