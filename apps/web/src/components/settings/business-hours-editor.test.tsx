import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BusinessHoursEditor } from './business-hours-editor';
import type { OfficeHours } from '@/lib/feature-types';

const WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

function renderEditor(value: OfficeHours = {}) {
  const onChange = vi.fn();
  const view = render(<BusinessHoursEditor value={value} onChange={onChange} />);
  return { ...view, onChange };
}

/** The two <input type="time"> controls belonging to the nth open day. */
function timeInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
}

function toggles() {
  return screen.getAllByRole('switch');
}

describe('BusinessHoursEditor', () => {
  it('renders all seven days, in week order', () => {
    renderEditor();
    for (const day of WEEK) {
      expect(screen.getByText(day)).toBeInTheDocument();
    }
    const rendered = WEEK.map((d) => screen.getByText(d));
    expect(rendered).toHaveLength(7);
  });

  it('defaults an unconfigured day to closed', () => {
    // A tenant who has never set hours must not be silently advertised as open
    // 09:00–18:00 seven days a week.
    renderEditor();
    expect(screen.getAllByText('Closed')).toHaveLength(7);
  });

  it('shows time pickers only for open days', () => {
    const { container } = renderEditor({
      monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
    });
    expect(timeInputs(container)).toHaveLength(2);
    expect(screen.getAllByText('Closed')).toHaveLength(6);
  });

  it('renders the stored open and close times', () => {
    const { container } = renderEditor({
      monday: { isOpen: true, openTime: '10:30', closeTime: '19:45' },
    });
    const [open, close] = timeInputs(container);
    expect(open).toHaveValue('10:30');
    expect(close).toHaveValue('19:45');
  });

  it('reflects each day’s own open state', () => {
    renderEditor({
      monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
      sunday: { isOpen: false, openTime: '09:00', closeTime: '18:00' },
    });
    expect(toggles()[0]).toBeChecked();
    expect(toggles()[6]).not.toBeChecked();
  });

  describe('opening a day', () => {
    it('emits the whole week with that day opened', () => {
      const { onChange } = renderEditor();
      fireEvent.click(toggles()[0]);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
        }),
      );
    });

    it('seeds sensible default hours for a day that had none', () => {
      const { onChange } = renderEditor();
      fireEvent.click(toggles()[2]);
      expect(onChange.mock.calls[0][0].wednesday).toEqual({
        isOpen: true,
        openTime: '09:00',
        closeTime: '18:00',
      });
    });

    it('preserves the times a previously-closed day already had', () => {
      // Re-opening Sunday should restore its old hours, not reset to 09:00.
      const { onChange } = renderEditor({
        sunday: { isOpen: false, openTime: '11:00', closeTime: '15:00' },
      });
      fireEvent.click(toggles()[6]);
      expect(onChange.mock.calls[0][0].sunday).toEqual({
        isOpen: true,
        openTime: '11:00',
        closeTime: '15:00',
      });
    });
  });

  describe('closing a day', () => {
    it('flips isOpen without discarding the hours', () => {
      const { onChange } = renderEditor({
        monday: { isOpen: true, openTime: '10:00', closeTime: '17:00' },
      });
      fireEvent.click(toggles()[0]);
      expect(onChange.mock.calls[0][0].monday).toEqual({
        isOpen: false,
        openTime: '10:00',
        closeTime: '17:00',
      });
    });
  });

  describe('editing times', () => {
    it('emits an updated open time', () => {
      const { container, onChange } = renderEditor({
        monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
      });
      fireEvent.change(timeInputs(container)[0], { target: { value: '08:30' } });
      expect(onChange.mock.calls[0][0].monday).toEqual({
        isOpen: true,
        openTime: '08:30',
        closeTime: '18:00',
      });
    });

    it('emits an updated close time', () => {
      const { container, onChange } = renderEditor({
        monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
      });
      fireEvent.change(timeInputs(container)[1], { target: { value: '20:00' } });
      expect(onChange.mock.calls[0][0].monday.closeTime).toBe('20:00');
    });
  });

  it('leaves the other six days untouched when one changes', () => {
    // The editor emits the whole OfficeHours object, so a bad spread here
    // would wipe the rest of the week on every keystroke.
    const value: OfficeHours = {
      monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' },
      saturday: { isOpen: true, openTime: '10:00', closeTime: '14:00' },
    };
    const { onChange } = renderEditor(value);
    fireEvent.click(toggles()[0]);
    expect(onChange.mock.calls[0][0].saturday).toEqual(value.saturday);
  });

  it('carries through extra day fields such as breaks', () => {
    const { onChange } = renderEditor({
      monday: {
        isOpen: true,
        openTime: '09:00',
        closeTime: '18:00',
        breakStart: '13:00',
        breakEnd: '14:00',
      },
    });
    fireEvent.click(toggles()[0]);
    expect(onChange.mock.calls[0][0].monday).toMatchObject({
      breakStart: '13:00',
      breakEnd: '14:00',
    });
  });

  it('stacks each row on mobile before going side-by-side', () => {
    const { container } = renderEditor();
    expect(container.querySelector('.flex-col')?.className).toContain('sm:flex-row');
  });
});
