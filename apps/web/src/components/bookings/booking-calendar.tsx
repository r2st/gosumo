'use client';

import { useMemo, useState } from 'react';
import {
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedTabs } from '@/components/ui/tabs';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { useCalendar } from '@/hooks/use-bookings';
import { formatTimeIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CalendarEvent } from '@/lib/commerce-types';
import type { BookingStatus } from '@/lib/types';

type View = 'week' | 'month';

const STATUS_DOT: Record<BookingStatus, string> = {
  CONFIRMED: 'bg-emerald-500',
  PENDING: 'bg-amber-500',
  RESCHEDULED: 'bg-amber-500',
  COMPLETED: 'bg-sky-500',
  CANCELLED: 'bg-rose-500',
  NO_SHOW: 'bg-rose-500',
};

function fmt(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function BookingCalendar({ onSelectBooking }: { onSelectBooking: (id: string) => void }) {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  const { rangeStart, rangeEnd, days } = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeek(anchor, { weekStartsOn: 1 });
      const end = endOfWeek(anchor, { weekStartsOn: 1 });
      return { rangeStart: start, rangeEnd: end, days: eachDayOfInterval({ start, end }) };
    }
    const mStart = startOfMonth(anchor);
    const mEnd = endOfMonth(anchor);
    const gridStart = startOfWeek(mStart, { weekStartsOn: 1 });
    const gridEnd = endOfWeek(mEnd, { weekStartsOn: 1 });
    return { rangeStart: gridStart, rangeEnd: gridEnd, days: eachDayOfInterval({ start: gridStart, end: gridEnd }) };
  }, [view, anchor]);

  const { data, isLoading, isError, refetch } = useCalendar({ from: fmt(rangeStart), to: fmt(rangeEnd) });

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of data?.events ?? []) {
      const key = format(parseISO(ev.start), 'yyyy-MM-dd');
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [data]);

  const step = (dir: 1 | -1) => setAnchor((d) => (view === 'week' ? addWeeks(d, dir) : addMonths(d, dir)));

  const heading = view === 'week' ? `${format(rangeStart, 'd MMM')} – ${format(rangeEnd, 'd MMM yyyy')}` : format(anchor, 'MMMM yyyy');

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => step(-1)} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => step(1)} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <h3 className="ml-1 text-sm font-semibold">{heading}</h3>
        </div>
        <SegmentedTabs
          items={[
            { key: 'week', label: 'Week' },
            { key: 'month', label: 'Month' },
          ]}
          activeKey={view}
          onChange={(k) => setView(k as View)}
        />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : view === 'week' ? (
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-7 sm:divide-x sm:divide-y-0">
          {days.map((day) => {
            const events = eventsByDay.get(fmt(day)) ?? [];
            const today = isSameDay(day, new Date());
            return (
              <div key={day.toISOString()} className="min-h-[8rem] p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-muted-foreground">{format(day, 'EEE')}</span>
                  <span
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                      today ? 'bg-primary text-primary-foreground' : 'text-foreground',
                    )}
                  >
                    {format(day, 'd')}
                  </span>
                </div>
                <div className="space-y-1">
                  {events.map((ev) => (
                    <button
                      key={ev.id}
                      onClick={() => onSelectBooking(ev.id)}
                      className="flex w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-left text-xs hover:bg-muted"
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[ev.status])} />
                      <span className="truncate">
                        <span className="font-medium">{formatTimeIST(ev.start)}</span> {ev.title}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-7 border-b border-border">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-2 text-center text-xs font-medium uppercase text-muted-foreground">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const events = eventsByDay.get(fmt(day)) ?? [];
              const today = isSameDay(day, new Date());
              const muted = !isSameMonth(day, anchor);
              return (
                <div
                  key={day.toISOString()}
                  className={cn('min-h-[6.5rem] border-b border-r border-border p-1.5', muted && 'bg-muted/30')}
                >
                  <div className="mb-1 flex justify-end">
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium',
                        today ? 'bg-primary text-primary-foreground' : muted ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {format(day, 'd')}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {events.slice(0, 3).map((ev) => (
                      <button
                        key={ev.id}
                        onClick={() => onSelectBooking(ev.id)}
                        className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted"
                      >
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[ev.status])} />
                        <span className="truncate">{ev.title}</span>
                      </button>
                    ))}
                    {events.length > 3 && <p className="px-1 text-[10px] text-muted-foreground">+{events.length - 3} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
