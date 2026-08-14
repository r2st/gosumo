'use client';

import { Switch } from '@/components/ui/switch';
import type { DaySchedule, OfficeHours, WeekDay } from '@/lib/feature-types';

const DAYS: { key: WeekDay; label: string }[] = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];

const DEFAULT_DAY: DaySchedule = { isOpen: true, openTime: '09:00', closeTime: '18:00' };

export function BusinessHoursEditor({
  value,
  onChange,
}: {
  value: OfficeHours;
  onChange: (next: OfficeHours) => void;
}) {
  const update = (day: WeekDay, patch: Partial<DaySchedule>) => {
    const current = value[day] ?? DEFAULT_DAY;
    onChange({ ...value, [day]: { ...current, ...patch } });
  };

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {DAYS.map(({ key, label }) => {
        const day = value[key] ?? { ...DEFAULT_DAY, isOpen: false };
        return (
          <div key={key} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
            <div className="flex w-40 items-center gap-3">
              {/* Seven identical switches down the card — the day has to be
                  in the name, not only in the sibling <span>. */}
              <Switch
                checked={day.isOpen}
                onChange={(v) => update(key, { isOpen: v })}
                ariaLabel={`Open on ${label}`}
              />
              <span className="text-sm font-medium text-foreground">{label}</span>
            </div>
            {day.isOpen ? (
              <div className="flex items-center gap-2 text-sm">
                <input
                  type="time"
                  value={day.openTime}
                  onChange={(e) => update(key, { openTime: e.target.value })}
                  className="h-9 rounded-md border border-input bg-card px-2"
                />
                <span className="text-muted-foreground">to</span>
                <input
                  type="time"
                  value={day.closeTime}
                  onChange={(e) => update(key, { closeTime: e.target.value })}
                  className="h-9 rounded-md border border-input bg-card px-2"
                />
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Closed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
