/**
 * UuidValidationPipe unit tests.
 *
 * The pipe guards path parameters that go straight into a Prisma `where`. Its
 * value is not really validation — it is *shape confinement*: a rejected
 * parameter never reaches the repository, so a malformed id cannot become a
 * driver error whose message leaks a table name through the 500 path.
 *
 * The `metadata.data ?? 'Parameter'` fallback is covered too, because a pipe
 * used positionally (`new UuidValidationPipe().transform(v, {} as ...)`) has no
 * parameter name and the message must still read sensibly.
 */

import { ArgumentMetadata, BadRequestException } from '@nestjs/common';

import { UuidValidationPipe } from './uuid-validation.pipe';

const pipe = new UuidValidationPipe();
const meta = (data?: string): ArgumentMetadata => ({ type: 'param', data });

describe('UuidValidationPipe', () => {
  it('passes a v4 UUID through unchanged', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(pipe.transform(id, meta('id'))).toBe(id);
  });

  it('accepts a nil UUID', () => {
    // `uuid.validate` accepts it; the pipe checks shape, not semantics, and a
    // nil id simply finds no row.
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(pipe.transform(nil, meta('id'))).toBe(nil);
  });

  it.each([
    ['not-a-uuid'],
    ['12345'],
    // One character short — the class of typo a length check alone would miss.
    ['3f2504e0-4f89-41d3-9a0c-0305e82c330'],
    // Valid shape, invalid hex.
    ['zzzzzzzz-4f89-41d3-9a0c-0305e82c3301'],
    // A SQL-ish payload: it must die at the pipe, not at the driver.
    ["' OR 1=1--"],
  ])('rejects %p', (value) => {
    expect(() => pipe.transform(value, meta('id'))).toThrow(BadRequestException);
  });

  it.each([['', 'empty'], [undefined as unknown as string, 'undefined']])(
    'rejects a %s value as missing rather than malformed',
    (value) => {
      expect(() => pipe.transform(value, meta('leadId'))).toThrow('leadId is required');
    },
  );

  it('names the parameter in the malformed message', () => {
    expect(() => pipe.transform('nope', meta('conversationId'))).toThrow(
      /conversationId must be a valid UUID/,
    );
  });

  it('falls back to a generic name when the pipe is applied positionally', () => {
    expect(() => pipe.transform('nope', meta(undefined))).toThrow(
      /^Parameter must be a valid UUID/,
    );
    expect(() => pipe.transform('', meta(undefined))).toThrow('Parameter is required');
  });

  it('echoes the received value so a caller can see their typo', () => {
    expect(() => pipe.transform('abc', meta('id'))).toThrow(/received: "abc"/);
  });
});
