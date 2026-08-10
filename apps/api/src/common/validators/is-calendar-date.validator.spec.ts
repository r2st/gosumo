/**
 * Tests for the calendar-aware date validator.
 *
 * The bar this has to clear is "everything @IsDateString() accepted still
 * passes, minus the dates that do not exist". A validator that is stricter
 * than that breaks live clients; one that is looser leaves the roll-forward
 * bug open. Both directions are pinned below.
 */

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { IsCalendarDateString, isCalendarDateString } from './is-calendar-date.validator';

describe('isCalendarDateString', () => {
  describe('accepts the shapes clients actually send', () => {
    it.each([
      ['UTC instant with milliseconds', '2026-09-01T10:30:00.000Z'],
      ['UTC instant without milliseconds', '2026-09-01T10:30:00Z'],
      ['instant with no seconds', '2026-09-01T10:30Z'],
      ['naive local date-time', '2026-09-01T10:30:00'],
      ['date only', '2026-09-01'],
      ['IST offset', '2026-09-01T16:00:00+05:30'],
      ['offset without a colon', '2026-09-01T16:00:00+0530'],
      ['negative offset', '2026-09-01T02:00:00-08:00'],
      ['space separator', '2026-09-01 10:30:00'],
      ['nanosecond precision', '2026-09-01T10:30:00.123456789Z'],
      ['leap day in a leap year', '2028-02-29T00:00:00Z'],
      ['last day of a 31-day month', '2026-01-31T23:59:59Z'],
      ['last day of a 30-day month', '2026-04-30T00:00:00Z'],
      ['midnight boundary', '2026-01-01T00:00:00Z'],
      ['last second of a year', '2026-12-31T23:59:59Z'],
    ])('%s', (_label, value) => {
      expect(isCalendarDateString(value)).toBe(true);
    });
  });

  describe('rejects dates that do not exist', () => {
    it.each([
      ['31 February', '2026-02-31T00:00:00Z'],
      ['30 February', '2026-02-30'],
      ['29 February in a common year', '2026-02-29T00:00:00Z'],
      ['29 February in a century non-leap year', '1900-02-29'],
      ['31 April', '2026-04-31T00:00:00Z'],
      ['31 June', '2026-06-31'],
      ['31 September', '2026-09-31'],
      ['31 November', '2026-11-31'],
      ['month 13', '2026-13-01T00:00:00Z'],
      ['month 00', '2026-00-15'],
      ['day 00', '2026-03-00'],
      ['day 32', '2026-03-32'],
    ])('%s', (_label, value) => {
      expect(isCalendarDateString(value)).toBe(false);
    });

    it('accepts 29 February in a year divisible by 400', () => {
      // 2000 is a leap year; 1900 is not. The round-trip check gets both right
      // because it delegates the rule to Date rather than re-deriving it.
      expect(isCalendarDateString('2000-02-29')).toBe(true);
    });
  });

  describe('rejects impossible times of day', () => {
    it.each([
      ['hour 24', '2026-09-01T24:00:00Z'],
      ['hour 99', '2026-09-01T99:00:00Z'],
      ['minute 60', '2026-09-01T10:60:00Z'],
      ['second 60 (leap second)', '2026-09-01T10:30:60Z'],
      ['second 99', '2026-09-01T10:30:99Z'],
    ])('%s', (_label, value) => {
      expect(isCalendarDateString(value)).toBe(false);
    });
  });

  describe('rejects malformed offsets', () => {
    it.each([
      ['offset beyond +14:00', '2026-09-01T10:00:00+15:00'],
      ['offset beyond -12:00', '2026-09-01T10:00:00-13:00'],
      ['offset minutes over 59', '2026-09-01T10:00:00+05:75'],
    ])('%s', (_label, value) => {
      expect(isCalendarDateString(value)).toBe(false);
    });

    it('accepts the real extremes', () => {
      expect(isCalendarDateString('2026-09-01T10:00:00+14:00')).toBe(true);
      expect(isCalendarDateString('2026-09-01T10:00:00-12:00')).toBe(true);
    });
  });

  describe('rejects non-ISO input', () => {
    it.each([
      ['free text', 'tomorrow'],
      ['empty string', ''],
      ['epoch milliseconds as a number', 1788200000000],
      ['epoch milliseconds as a string', '1788200000000'],
      ['a Date object', new Date('2026-09-01')],
      ['null', null],
      ['undefined', undefined],
      ['an object', { year: 2026 }],
      ['US-style slashes', '09/01/2026'],
      ['basic format without separators', '20260901'],
      ['week date', '2026-W05-1'],
      ['ordinal date', '2026-244'],
      ['two-digit year', '26-09-01'],
      ['trailing junk', '2026-09-01T10:30:00Zjunk'],
      ['SQL injection shaped string', "2026-09-01'; DROP TABLE messages;--"],
    ])('%s', (_label, value) => {
      expect(isCalendarDateString(value)).toBe(false);
    });
  });
});

describe('@IsCalendarDateString() through the production ValidationPipe', () => {
  class ScheduleDto {
    @IsCalendarDateString()
    runAt!: string;
  }

  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta: ArgumentMetadata = {
    type: 'body',
    metatype: ScheduleDto as ArgumentMetadata['metatype'],
  };

  it('passes a real date through unchanged', async () => {
    const dto = (await pipe.transform({ runAt: '2026-09-01T10:30:00.000Z' }, meta)) as ScheduleDto;
    expect(dto.runAt).toBe('2026-09-01T10:30:00.000Z');
  });

  it('rejects 31 February at the pipe boundary', async () => {
    await expect(pipe.transform({ runAt: '2026-02-31T00:00:00Z' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('names the calendar fault in the error message', async () => {
    // The client needs to know the date does not exist, not just that
    // something about the field was wrong.
    await expect(pipe.transform({ runAt: '2026-02-31' }, meta)).rejects.toMatchObject({
      response: { message: ['runAt must be a date that exists on the calendar'] },
    });
  });

  it('distinguishes a format fault from a calendar fault', async () => {
    await expect(pipe.transform({ runAt: 'tomorrow' }, meta)).rejects.toMatchObject({
      response: {
        message: ['runAt must be an ISO-8601 date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ)'],
      },
    });
  });

  it('names the time fault for an out-of-range hour', async () => {
    await expect(pipe.transform({ runAt: '2026-09-01T24:00:00Z' }, meta)).rejects.toMatchObject({
      response: { message: ['runAt must have a valid time of day (00:00:00 through 23:59:59)'] },
    });
  });

  it('names the offset fault for an impossible zone', async () => {
    await expect(pipe.transform({ runAt: '2026-09-01T10:00:00+15:00' }, meta)).rejects.toMatchObject(
      { response: { message: ['runAt must have a UTC offset between -12:00 and +14:00'] } },
    );
  });
});
