/**
 * The analytics chart kit and its date-range picker.
 *
 * These are the two pieces of the analytics surface that are pure logic rather
 * than layout, and both make a decision the charts depend on. `toPct` guesses
 * whether a number is a 0–1 ratio or an already-scaled percentage, which is the
 * kind of heuristic that silently renders 0.87% instead of 87%. `buildRange`
 * picks the bucket granularity the API is asked for — get it wrong and a 90-day
 * chart asks for hourly points.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LegendDot, MeterBar, shortDate, toPct, CHANNEL_COLORS, SERIES_COLORS } from './chart-kit';
import { DateRangePicker, buildRange, defaultRange } from './date-range-picker';

describe('toPct', () => {
  it('scales a 0–1 ratio into a percentage', () => {
    expect(toPct(0.87)).toBeCloseTo(87);
    expect(toPct(0)).toBe(0);
  });

  it('leaves an already-scaled percentage alone', () => {
    expect(toPct(87)).toBe(87);
    expect(toPct(100)).toBe(100);
  });

  it('treats exactly 1 as a full ratio, not one percent', () => {
    // The ambiguous case: the API sends confidence as 0–1, so 1 means 100%.
    expect(toPct(1)).toBe(100);
  });

  it('falls back to zero for a missing or unusable value', () => {
    expect(toPct(null)).toBe(0);
    expect(toPct(undefined)).toBe(0);
    expect(toPct(Number.NaN)).toBe(0);
  });
});

describe('shortDate', () => {
  it('drops the year from a formatted date', () => {
    expect(shortDate('2026-06-27T00:00:00.000Z')).not.toMatch(/2026/);
    expect(shortDate('2026-06-27T00:00:00.000Z')).toMatch(/Jun/);
  });

  it('renders an em dash rather than throwing on an unparseable value', () => {
    // `formatDateIST` already absorbs bad input, so shortDate's own try/catch
    // never fires — an axis tick degrades to a dash instead of an exception.
    expect(shortDate('not-a-date')).toBe('—');
  });
});

describe('palettes', () => {
  it('gives every supported channel its own colour', () => {
    expect(Object.keys(CHANNEL_COLORS).sort()).toEqual([
      'EMAIL',
      'INSTAGRAM',
      'SMS',
      'WEB_CHAT',
      'WHATSAPP',
    ]);
  });

  it('offers enough categorical colours that series do not collide early', () => {
    expect(SERIES_COLORS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SERIES_COLORS).size).toBe(SERIES_COLORS.length);
  });
});

describe('LegendDot', () => {
  it('renders the label and swatch, and the value only when given', () => {
    const { rerender } = render(<LegendDot color="#25D366" label="WhatsApp" />);
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.queryByText('412')).toBeNull();

    rerender(<LegendDot color="#25D366" label="WhatsApp" value="412" />);
    expect(screen.getByText('412')).toBeInTheDocument();
  });
});

describe('MeterBar', () => {
  it('renders the label and its value', () => {
    render(<MeterBar label="Pricing" valueLabel="62% · 25" fraction={0.62} />);
    expect(screen.getByText('Pricing')).toBeInTheDocument();
    expect(screen.getByText('62% · 25')).toBeInTheDocument();
  });

  it('keeps a sliver of bar visible for a near-zero fraction', () => {
    // A 0-width bar reads as a rendering bug rather than "almost nothing".
    const { container } = render(<MeterBar label="Rare" valueLabel="0%" fraction={0} />);
    const fill = container.querySelector('div[style*="width"]') as HTMLElement;
    expect(fill.style.width).toBe('3%');
  });

  it('scales the bar with the fraction', () => {
    const { container } = render(<MeterBar label="Half" valueLabel="50%" fraction={0.5} />);
    const fill = container.querySelector('div[style*="width"]') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });
});

describe('buildRange', () => {
  it('asks for hourly buckets over today and weekly over 90 days', () => {
    expect(buildRange('today').granularity).toBe('HOUR');
    expect(buildRange('90d').granularity).toBe('WEEK');
  });

  it('asks for daily buckets over the mid-length presets', () => {
    expect(buildRange('7d').granularity).toBe('DAY');
    expect(buildRange('30d').granularity).toBe('DAY');
  });

  it('starts today at midnight rather than 24 hours ago', () => {
    const range = buildRange('today');
    expect(new Date(range.from).getHours()).toBe(0);
    expect(new Date(range.from).getMinutes()).toBe(0);
  });

  it('spans the requested number of whole days', () => {
    const range = buildRange('7d');
    const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    // From midnight seven days ago to now — at least 7, under 8.
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThan(8);
  });

  it('falls back to 30 days for an unrecognised preset', () => {
    const range = buildRange('custom');
    expect(range.granularity).toBe('DAY');
    const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(30);
  });

  it('covers a custom range end-to-end, midnight to just before midnight', () => {
    const range = buildRange('custom', { from: '2026-06-01', to: '2026-06-15' });
    expect(new Date(range.from).getHours()).toBe(0);
    expect(new Date(range.to).getHours()).toBe(23);
    expect(new Date(range.to).getMinutes()).toBe(59);
    expect(range.preset).toBe('custom');
  });

  it('picks the custom granularity from the span, not the preset', () => {
    expect(buildRange('custom', { from: '2026-06-01', to: '2026-06-02' }).granularity).toBe('HOUR');
    expect(buildRange('custom', { from: '2026-06-01', to: '2026-06-20' }).granularity).toBe('DAY');
    expect(buildRange('custom', { from: '2026-01-01', to: '2026-06-20' }).granularity).toBe('WEEK');
  });

  it('defaults the dashboard to the last 30 days', () => {
    expect(defaultRange().preset).toBe('30d');
  });
});

describe('DateRangePicker', () => {
  it('reports a new range when a preset is picked', () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={defaultRange()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ preset: '7d' }));
  });

  it('hides the custom inputs until Custom is opened, and closes on a preset', () => {
    render(<DateRangePicker value={defaultRange()} onChange={vi.fn()} />);
    expect(document.querySelector('input[type="date"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it('opens already showing the custom inputs when the value is custom', () => {
    render(
      <DateRangePicker
        value={buildRange('custom', { from: '2026-06-01', to: '2026-06-15' })}
        onChange={vi.fn()}
      />,
    );
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(2);
  });

  it('applies the typed custom dates only when Apply is pressed', () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={defaultRange()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));

    const [from, to] = Array.from(document.querySelectorAll('input[type="date"]'));
    fireEvent.change(from, { target: { value: '2026-06-01' } });
    fireEvent.change(to, { target: { value: '2026-06-15' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'custom', granularity: 'DAY' }),
    );
  });

  it('stops each custom input from crossing the other', () => {
    render(<DateRangePicker value={defaultRange()} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
    const [from, to] = Array.from(document.querySelectorAll('input[type="date"]'));
    fireEvent.change(from, { target: { value: '2026-06-05' } });
    expect(to).toHaveAttribute('min', '2026-06-05');
    fireEvent.change(to, { target: { value: '2026-06-20' } });
    expect(from).toHaveAttribute('max', '2026-06-20');
  });
});
