import { maskEmail, maskPhone } from './log-redact.util';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('suman@example.com')).toBe('s****@example.com');
  });

  it('keeps the domain so failed-login clustering still works', () => {
    // "twenty failures, all @somecorp.com" is an operational signal about an
    // organisation, not about a person.
    expect(maskEmail('a.very.long.name@somecorp.co.in')).toMatch(/@somecorp\.co\.in$/);
  });

  it('does not leak the local part', () => {
    const masked = maskEmail('firstname.lastname@example.com');
    expect(masked).not.toContain('lastname');
    expect(masked).not.toContain('firstname');
  });

  it('masks a plus-addressed local part completely', () => {
    // `user+tag@` would otherwise leak the tag, which is often a real name.
    expect(maskEmail('user+recruiting@example.com')).toBe('u**************@example.com');
  });

  it('splits on the last @, not the first', () => {
    expect(maskEmail('weird@name@example.com')).toBe('w*********@example.com');
  });

  it('stars a single-character local part rather than echoing it bare', () => {
    expect(maskEmail('a@example.com')).toBe('a*@example.com');
  });

  it.each([
    ['a non-address', 'not-an-email'],
    ['a leading @', '@example.com'],
    ['a trailing @', 'user@'],
    ['empty', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ])('redacts %s entirely', (_label, value) => {
    expect(maskEmail(value)).toBe('[redacted]');
  });
});

describe('maskPhone', () => {
  it('keeps the prefix and the last four', () => {
    expect(maskPhone('+919876543210')).toBe('+9198****3210');
  });

  it('masks a formatted number identically to a bare one', () => {
    // `+91 98765 43210` and `+919876543210` are the same number; if they mask
    // differently, the mask has leaked the formatting and broken correlation.
    expect(maskPhone('+91 98765 43210')).toBe(maskPhone('+919876543210'));
  });

  it('does not leak the middle digits', () => {
    const masked = maskPhone('+919876543210');
    expect(masked).not.toContain('76543');
  });

  it('handles a number with no country prefix', () => {
    const masked = maskPhone('9876543210');
    expect(masked.startsWith('+')).toBe(false);
    expect(masked.endsWith('3210')).toBe(true);
  });

  it('keeps two different numbers distinguishable', () => {
    // Correlating "same caller across two lines" is the reason to keep any
    // digits at all.
    expect(maskPhone('+919876543210')).not.toBe(maskPhone('+919876541111'));
  });

  it.each([
    ['too short to mask meaningfully', '12345'],
    ['a WhatsApp wa_id fragment', '123'],
    ['empty', ''],
    ['whitespace', '   '],
    ['undefined', undefined],
    ['null', null],
    ['a number', 919876543210],
  ])('redacts %s entirely', (_label, value) => {
    // Half-showing a short value is worse than dropping it: there is not
    // enough left to mask.
    expect(maskPhone(value)).toBe('[redacted]');
  });
});
