import { ArgumentMetadata, BadRequestException } from '@nestjs/common';

import { OptionalUuidPipe } from './optional-uuid.pipe';

const pipe = new OptionalUuidPipe();
const meta = (data?: string): ArgumentMetadata => ({ type: 'query', data });

describe('OptionalUuidPipe', () => {
  it('passes a valid UUID through unchanged', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(pipe.transform(id, meta('orderId'))).toBe(id);
  });

  it('returns undefined for an undefined value', () => {
    expect(pipe.transform(undefined, meta('orderId'))).toBeUndefined();
  });

  it('returns undefined for a null value', () => {
    expect(pipe.transform(null as unknown as undefined, meta('orderId'))).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(pipe.transform('', meta('orderId'))).toBeUndefined();
  });

  it('rejects a non-UUID string', () => {
    expect(() => pipe.transform('not-a-uuid', meta('orderId'))).toThrow(BadRequestException);
  });

  it('rejects a SQL injection attempt', () => {
    expect(() => pipe.transform("' OR 1=1--", meta('leadId'))).toThrow(BadRequestException);
  });

  it('names the parameter in the error message', () => {
    expect(() => pipe.transform('nope', meta('variantId'))).toThrow(
      /variantId must be a valid UUID/,
    );
  });

  it('falls back to a generic name when applied positionally', () => {
    expect(() => pipe.transform('nope', meta(undefined))).toThrow(
      /^Parameter must be a valid UUID/,
    );
  });
});
