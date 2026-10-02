import { ArgumentMetadata, BadRequestException } from '@nestjs/common';

import { SafeStringPipe } from './safe-string.pipe';

const pipe = new SafeStringPipe();
const meta = (data?: string): ArgumentMetadata => ({ type: 'param', data });

describe('SafeStringPipe', () => {
  it('passes a simple alphanumeric string through unchanged', () => {
    expect(pipe.transform('razorpay', meta('provider'))).toBe('razorpay');
  });

  it('accepts hyphens and underscores', () => {
    expect(pipe.transform('google-calendar', meta('provider'))).toBe('google-calendar');
    expect(pipe.transform('web_chat', meta('provider'))).toBe('web_chat');
  });

  it('accepts mixed case', () => {
    expect(pipe.transform('GoogleCalendar', meta('provider'))).toBe('GoogleCalendar');
  });

  it.each([
    ['hello world', 'spaces'],
    ['provider;DROP TABLE', 'semicolons'],
    ['../../../etc/passwd', 'path traversal'],
    ['<script>alert(1)</script>', 'HTML'],
    ["' OR 1=1--", 'SQL injection'],
    ['provider\x00name', 'null byte'],
    ['a'.repeat(101), 'over default max length'],
  ])('rejects %p (%s)', (value) => {
    expect(() => pipe.transform(value, meta('provider'))).toThrow(BadRequestException);
  });

  it.each([['', 'empty'], [undefined as unknown as string, 'undefined']])(
    'rejects a %s value as missing',
    (value) => {
      expect(() => pipe.transform(value, meta('provider'))).toThrow('provider is required');
    },
  );

  it('names the parameter in the error message', () => {
    expect(() => pipe.transform('a b', meta('slug'))).toThrow(/slug/);
  });

  it('falls back to a generic name when applied positionally', () => {
    expect(() => pipe.transform('', meta(undefined))).toThrow('Parameter is required');
    expect(() => pipe.transform('a b', meta(undefined))).toThrow(/Parameter/);
  });

  it('respects a custom max length', () => {
    const shortPipe = new SafeStringPipe(5);
    expect(shortPipe.transform('abcde', meta('code'))).toBe('abcde');
    expect(() => shortPipe.transform('abcdef', meta('code'))).toThrow(/at most 5/);
  });

  it('rejects an excessively long value with default limit', () => {
    const longValue = 'a'.repeat(101);
    expect(() => pipe.transform(longValue, meta('name'))).toThrow(/at most 100/);
  });
});
