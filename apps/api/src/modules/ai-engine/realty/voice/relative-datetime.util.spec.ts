import { parseRelativeDateTime } from './relative-datetime.util';

// Thursday 3 Jul 2026, 10:00 local time.
const NOW = new Date(2026, 6, 3, 10, 0, 0, 0);

function ymdhm(d: Date) {
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
}

describe('parseRelativeDateTime', () => {
  it('resolves "tomorrow 5pm"', () => {
    expect(ymdhm(parseRelativeDateTime('tomorrow 5pm', NOW)!)).toEqual([2026, 6, 4, 17, 0]);
  });

  it('resolves "today at 3:30pm"', () => {
    expect(ymdhm(parseRelativeDateTime('today at 3:30pm', NOW)!)).toEqual([2026, 6, 3, 15, 30]);
  });

  it('resolves "day after 11am"', () => {
    expect(ymdhm(parseRelativeDateTime('day after 11am', NOW)!)).toEqual([2026, 6, 5, 11, 0]);
  });

  it('keeps a bare future time today', () => {
    expect(ymdhm(parseRelativeDateTime('5pm', NOW)!)).toEqual([2026, 6, 3, 17, 0]);
  });

  it('rolls a bare past time to tomorrow', () => {
    // 9am is before the 10:00 "now", with no day word → next day.
    expect(ymdhm(parseRelativeDateTime('9am', NOW)!)).toEqual([2026, 6, 4, 9, 0]);
  });

  it('assumes afternoon for a bare small hour (realty visits)', () => {
    // "5" → 17:00 today.
    expect(ymdhm(parseRelativeDateTime('at 5', NOW)!)).toEqual([2026, 6, 3, 17, 0]);
  });

  it('returns null without a clock time', () => {
    expect(parseRelativeDateTime('tomorrow', NOW)).toBeNull();
    expect(parseRelativeDateTime('sometime soon', NOW)).toBeNull();
    expect(parseRelativeDateTime('', NOW)).toBeNull();
  });
});
