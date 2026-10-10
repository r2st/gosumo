'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

interface WeekData { week: string; count: number }

const defaultWeeks: WeekData[] = [
  { week: 'Week 1', count: 120 },
  { week: 'Week 2', count: 135 },
  { week: 'Week 3', count: 128 },
  { week: 'Week 4', count: 142 },
];

export function TicketVolumeForecaster() {
  const [weeks, setWeeks] = useState<WeekData[]>(defaultWeeks);
  const [newCount, setNewCount] = useState('');
  const [growthRate, setGrowthRate] = useState(5);

  const addWeek = () => {
    const v = parseInt(newCount, 10);
    if (!isNaN(v) && v >= 0) {
      setWeeks([...weeks, { week: `Week ${weeks.length + 1}`, count: v }]);
      setNewCount('');
    }
  };

  const removeWeek = (i: number) => setWeeks(weeks.filter((_, idx) => idx !== i));

  const avg = weeks.length ? weeks.reduce((s, w) => s + w.count, 0) / weeks.length : 0;
  const trend = weeks.length >= 2
    ? ((weeks[weeks.length - 1].count - weeks[0].count) / Math.max(weeks[0].count, 1)) * 100
    : 0;
  const forecastNext = Math.round(avg * (1 + growthRate / 100));
  const forecastMonth = forecastNext * 4;

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        Ticket Volume Forecaster
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Predict weekly and monthly ticket volume from historical data to plan staffing and resources.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Expected Growth Rate (%)</label>
          <input
            type="number"
            value={growthRate}
            onChange={(e) => setGrowthRate(Number(e.target.value))}
            className="w-32 px-3 py-2 rounded-md text-sm"
          />
        </div>

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-3">Historical Weekly Volumes</h2>
          <div className="space-y-2 mb-4">
            {weeks.map((w, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-sm text-[var(--doaide-text-muted)] w-16">{w.week}</span>
                <div className="flex-1 h-6 rounded bg-[var(--doaide-bg)] overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--doaide-gold)]"
                    style={{ width: `${Math.min((w.count / Math.max(...weeks.map(x => x.count), 1)) * 100, 100)}%` }}
                  />
                </div>
                <span className="text-sm font-mono text-[var(--doaide-text)] w-12 text-right">{w.count}</span>
                <button onClick={() => removeWeek(i)} className="text-[var(--doaide-text-muted)] hover:text-[var(--doaide-error)] text-sm" aria-label={`Remove ${w.week}`}>&times;</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              min={0}
              value={newCount}
              onChange={(e) => setNewCount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWeek()}
              placeholder="Ticket count"
              className="flex-1 px-3 py-2 rounded-md text-sm"
            />
            <button onClick={addWeek} className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)]">Add Week</button>
          </div>
        </div>

        {weeks.length > 0 && (
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Weekly Average" value={`${Math.round(avg)}`} />
            <Stat label="Trend" value={`${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`} highlight={trend <= 0} />
            <Stat label="Next Week Forecast" value={`${forecastNext}`} />
            <Stat label="Monthly Forecast" value={`${forecastMonth}`} />
          </div>
        )}

        <ShareButtons url="https://gosumo.aiknol.com/tools/ticket-volume-forecaster" title="Ticket Volume Forecaster — Free tool by GoSumo Realty" />
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
