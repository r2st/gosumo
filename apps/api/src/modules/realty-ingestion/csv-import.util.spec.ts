import {
  splitCsvLine,
  parseCsvText,
  normalizeCsvRows,
} from './csv-import.util';
import { LeadSource } from '@gosumo/shared';

describe('splitCsvLine', () => {
  it('splits plain fields and trims whitespace', () => {
    expect(splitCsvLine('a, b ,c')).toEqual(['a', 'b', 'c']);
  });
  it('honours quoted fields containing commas and escaped quotes', () => {
    expect(splitCsvLine('"Sharma, Priya","say ""hi""",9876543210')).toEqual([
      'Sharma, Priya',
      'say "hi"',
      '9876543210',
    ]);
  });
});

describe('parseCsvText', () => {
  it('maps header aliases to canonical fields and skips blank lines', () => {
    const text = [
      'Full Name,Mobile,Email,Project',
      'Priya,9876543210,priya@x.com,Lakeside',
      '',
      'Amit,09811122233,,Green Acres',
    ].join('\n');
    const rows = parseCsvText(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'Priya',
      phone: '9876543210',
      email: 'priya@x.com',
      listingRef: 'Lakeside',
    });
    expect(rows[1]!.phone).toBe('09811122233');
  });

  it('returns [] when there is no data row', () => {
    expect(parseCsvText('phone,name')).toEqual([]);
    expect(parseCsvText('')).toEqual([]);
  });
});

describe('normalizeCsvRows', () => {
  it('normalizes phones to E.164 and defaults the source to CSV', () => {
    const { valid, errors } = normalizeCsvRows([
      { phone: '98765 43210', name: 'Priya' },
      { phone: '0091-9811122233', source: 'REFERRAL' },
    ]);
    expect(errors).toHaveLength(0);
    expect(valid[0]).toEqual({
      phone: '+919876543210',
      name: 'Priya',
      email: undefined,
      source: LeadSource.CSV,
      subSource: undefined,
      listingRef: undefined,
    });
    expect(valid[1]!.phone).toBe('+919811122233');
    expect(valid[1]!.source).toBe('REFERRAL');
  });

  it('reports invalid/missing phones as row errors (1-based)', () => {
    const { valid, errors } = normalizeCsvRows([
      { phone: '9876543210' },
      { phone: '12345' },
      { name: 'no phone' },
    ]);
    expect(valid).toHaveLength(1);
    expect(errors).toEqual([
      { row: 2, reason: 'Invalid phone: "12345"' },
      { row: 3, reason: 'Missing phone' },
    ]);
  });
});
