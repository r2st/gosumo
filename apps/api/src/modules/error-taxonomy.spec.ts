/**
 * Contract tests for the GoSumo error taxonomy.
 *
 * The taxonomy's whole value is that `code` is a stable discriminant clients,
 * queue consumers, and the HTTP filter can branch on. That only holds if three
 * things stay true, and each is asserted here:
 *
 *  1. Every error class keeps the code / status / retryability it advertises.
 *     These are public API — a silent change breaks callers that branch on them.
 *  2. `errorCodeForStatus` classifies *every* status, including ones with no
 *     dedicated code, so the filter can always produce a code for the ~314
 *     framework exceptions the platform still throws.
 *  3. `context` never reaches `message`. Context carries ids, tenant ids, and
 *     provider bodies; message is what a caller sees.
 */

import {
  ErrorCode,
  GoSumoError,
  ResourceNotFoundError,
  ValidationError,
  UnauthenticatedError,
  ForbiddenActionError,
  ConflictError,
  RateLimitExceededError,
  ExternalServiceError,
  ConfigurationError,
  PayloadParseError,
  UnsupportedOperationError,
  InternalError,
  errorCodeForStatus,
  isRetryableStatus,
  isGoSumoError,
  isRetryableError,
  errorMessage,
} from '@gosumo/shared';

describe('ErrorCode enum', () => {
  it('is self-consistent — every key equals its value', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('covers every status class the API actually returns', () => {
    // Guards against a status being added to the filter with no code to match.
    const codes = Object.values(ErrorCode);
    expect(codes).toEqual(
      expect.arrayContaining([
        ErrorCode.VALIDATION_FAILED,
        ErrorCode.UNAUTHENTICATED,
        ErrorCode.FORBIDDEN,
        ErrorCode.RESOURCE_NOT_FOUND,
        ErrorCode.CONFLICT,
        ErrorCode.UNSUPPORTED_OPERATION,
        ErrorCode.RATE_LIMIT_EXCEEDED,
        ErrorCode.EXTERNAL_SERVICE_ERROR,
        ErrorCode.INTERNAL_ERROR,
      ]),
    );
  });
});

describe('error classes — advertised code, status, retryability', () => {
  const cases: Array<{
    name: string;
    error: GoSumoError;
    code: ErrorCode;
    status: number;
    retryable: boolean;
  }> = [
    {
      name: 'ResourceNotFoundError',
      error: new ResourceNotFoundError('Lead', 'lead-1'),
      code: ErrorCode.RESOURCE_NOT_FOUND,
      status: 404,
      retryable: false,
    },
    {
      name: 'ValidationError',
      error: new ValidationError('budget must be positive'),
      code: ErrorCode.VALIDATION_FAILED,
      status: 400,
      retryable: false,
    },
    {
      name: 'UnauthenticatedError',
      error: new UnauthenticatedError('token expired'),
      code: ErrorCode.UNAUTHENTICATED,
      status: 401,
      retryable: false,
    },
    {
      name: 'ForbiddenActionError',
      error: new ForbiddenActionError('only an OWNER may do that'),
      code: ErrorCode.FORBIDDEN,
      status: 403,
      retryable: false,
    },
    {
      name: 'ConflictError',
      error: new ConflictError('order already cancelled'),
      code: ErrorCode.CONFLICT,
      status: 409,
      retryable: false,
    },
    {
      name: 'UnsupportedOperationError',
      error: new UnsupportedOperationError('SMS cannot carry a carousel'),
      code: ErrorCode.UNSUPPORTED_OPERATION,
      status: 422,
      retryable: false,
    },
    {
      name: 'RateLimitExceededError',
      error: new RateLimitExceededError('too many sends', 30),
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      status: 429,
      retryable: true,
    },
    {
      name: 'ConfigurationError',
      error: new ConfigurationError('OPENROUTER_API_KEY', 'missing API key'),
      code: ErrorCode.CONFIGURATION_ERROR,
      status: 500,
      retryable: false,
    },
    {
      name: 'PayloadParseError',
      error: new PayloadParseError('meta-webhook', 'entry[0] absent'),
      code: ErrorCode.PAYLOAD_PARSE_ERROR,
      status: 400,
      retryable: false,
    },
    {
      name: 'InternalError',
      error: new InternalError('unclassified fault'),
      code: ErrorCode.INTERNAL_ERROR,
      status: 500,
      retryable: true,
    },
  ];

  it.each(cases)('$name carries its code, status and retryability', (c) => {
    expect(c.error.code).toBe(c.code);
    expect(c.error.httpStatus).toBe(c.status);
    expect(c.error.retryable).toBe(c.retryable);
  });

  it.each(cases)('$name is a GoSumoError and a real Error', (c) => {
    // The prototype chain survives the ES5 class-extends-Error downlevel.
    expect(isGoSumoError(c.error)).toBe(true);
    expect(c.error).toBeInstanceOf(Error);
    expect(c.error).toBeInstanceOf(GoSumoError);
  });

  it.each(cases)('$name names itself for the log line', (c) => {
    expect(c.error.name).toBe(c.name);
  });

  it.each(cases)('$name round-trips through toJSON', (c) => {
    expect(c.error.toJSON()).toEqual({
      name: c.name,
      code: c.code,
      httpStatus: c.status,
      retryable: c.retryable,
      message: c.error.message,
      context: c.error.context,
    });
  });
});

describe('context stays out of the message', () => {
  it('keeps the resource id in context, not in the message', () => {
    const err = new ResourceNotFoundError('Lead', 'lead-secret-id');

    expect(err.message).toBe('Lead not found');
    expect(err.message).not.toContain('lead-secret-id');
    expect(err.context).toEqual({ resource: 'Lead', resourceId: 'lead-secret-id' });
  });

  it('merges caller context without losing the built-in keys', () => {
    const err = new ResourceNotFoundError('Lead', 'lead-1', {
      context: { businessId: 'biz-1' },
    });

    expect(err.context).toEqual({
      resource: 'Lead',
      resourceId: 'lead-1',
      businessId: 'biz-1',
    });
  });

  it('lets caller context override a built-in key', () => {
    const err = new PayloadParseError('meta', 'bad body', {
      context: { source: 'meta-v2' },
    });

    expect(err.context).toEqual({ source: 'meta-v2' });
  });

  it('defaults context to an empty object', () => {
    expect(new ValidationError('nope').context).toEqual({});
  });

  it('preserves an explicit cause for the stack chain', () => {
    const cause = new Error('socket hang up');
    const err = new ExternalServiceError('razorpay', 'unreachable', { cause });

    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it('leaves cause absent when none was given', () => {
    const err = new ValidationError('nope');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it('puts the config key in context, not the message', () => {
    const err = new ConfigurationError('RAZORPAY_KEY_SECRET', 'not configured');

    expect(err.message).toBe('not configured');
    expect(err.context).toEqual({ configKey: 'RAZORPAY_KEY_SECRET' });
  });

  it('records retryAfterSeconds in context', () => {
    expect(new RateLimitExceededError('slow down', 45).context).toEqual({
      retryAfterSeconds: 45,
    });
  });

  it('tolerates a rate limit with no retry-after hint', () => {
    const err = new RateLimitExceededError('slow down');

    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.retryable).toBe(true);
  });
});

describe('ExternalServiceError retryability', () => {
  it('prefixes the service name onto the message', () => {
    expect(new ExternalServiceError('razorpay', 'timed out').message).toBe(
      'razorpay: timed out',
    );
  });

  it.each([
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])('derives retryable=%s from provider status %s', (status, expected) => {
    expect(new ExternalServiceError('meta', 'x', { status }).retryable).toBe(expected);
    expect(isRetryableStatus(status)).toBe(expected);
  });

  it('retries a transport-level failure with no status at all', () => {
    // DNS failure, socket reset — the request may never have landed.
    expect(new ExternalServiceError('meta', 'ECONNRESET').retryable).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true);
  });

  it('lets an explicit retryable flag override the status heuristic', () => {
    expect(
      new ExternalServiceError('meta', 'x', { status: 500, retryable: false }).retryable,
    ).toBe(false);
    expect(
      new ExternalServiceError('meta', 'x', { status: 400, retryable: true }).retryable,
    ).toBe(true);
  });

  it('records the service and status in context', () => {
    expect(new ExternalServiceError('razorpay', 'boom', { status: 502 }).context).toEqual({
      service: 'razorpay',
      status: 502,
    });
  });
});

describe('errorCodeForStatus', () => {
  it.each([
    [400, ErrorCode.VALIDATION_FAILED],
    [401, ErrorCode.UNAUTHENTICATED],
    [403, ErrorCode.FORBIDDEN],
    [404, ErrorCode.RESOURCE_NOT_FOUND],
    [409, ErrorCode.CONFLICT],
    [422, ErrorCode.UNSUPPORTED_OPERATION],
    [429, ErrorCode.RATE_LIMIT_EXCEEDED],
    [502, ErrorCode.EXTERNAL_SERVICE_ERROR],
    [503, ErrorCode.EXTERNAL_SERVICE_ERROR],
    [504, ErrorCode.EXTERNAL_SERVICE_ERROR],
  ])('maps %s to %s', (status, code) => {
    expect(errorCodeForStatus(status)).toBe(code);
  });

  it.each([405, 406, 410, 412, 415, 418, 499])(
    'falls back to VALIDATION_FAILED for the unmapped 4xx %s',
    (status) => {
      expect(errorCodeForStatus(status)).toBe(ErrorCode.VALIDATION_FAILED);
    },
  );

  it.each([500, 501, 505, 599])(
    'falls back to INTERNAL_ERROR for the unmapped 5xx %s',
    (status) => {
      expect(errorCodeForStatus(status)).toBe(ErrorCode.INTERNAL_ERROR);
    },
  );

  it.each([0, 200, 204, 302, 399])(
    'treats the non-error status %s as INTERNAL_ERROR',
    (status) => {
      // Reaching the filter at all means something failed, whatever the status
      // claims — classify it as ours rather than inventing a caller fault.
      expect(errorCodeForStatus(status)).toBe(ErrorCode.INTERNAL_ERROR);
    },
  );

  it('returns a real enum member for every status in 100..599', () => {
    const valid = new Set<string>(Object.values(ErrorCode));
    for (let status = 100; status < 600; status++) {
      expect(valid.has(errorCodeForStatus(status))).toBe(true);
    }
  });

  it('agrees with each typed error that owns a status outright', () => {
    // Where a status has exactly one owning class, the reverse mapping must
    // land back on that class's code — otherwise a framework exception and a
    // typed error at the same status would report different codes.
    expect(errorCodeForStatus(new ResourceNotFoundError('L', '1').httpStatus))
      .toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(errorCodeForStatus(new UnauthenticatedError('x').httpStatus))
      .toBe(ErrorCode.UNAUTHENTICATED);
    expect(errorCodeForStatus(new ForbiddenActionError('x').httpStatus))
      .toBe(ErrorCode.FORBIDDEN);
    expect(errorCodeForStatus(new ConflictError('x').httpStatus))
      .toBe(ErrorCode.CONFLICT);
    expect(errorCodeForStatus(new UnsupportedOperationError('x').httpStatus))
      .toBe(ErrorCode.UNSUPPORTED_OPERATION);
    expect(errorCodeForStatus(new RateLimitExceededError('x').httpStatus))
      .toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
    expect(errorCodeForStatus(new ExternalServiceError('s', 'x').httpStatus))
      .toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
  });

  it('does not round-trip statuses shared by more than one class', () => {
    // 400 is both ValidationError and PayloadParseError; 500 is both
    // ConfigurationError and InternalError. The status alone cannot recover
    // which one was meant, so the throw site's own code always wins in the
    // filter — this asserts the ambiguity is real and understood, not a bug.
    expect(new PayloadParseError('s', 'x').httpStatus).toBe(400);
    expect(errorCodeForStatus(400)).not.toBe(ErrorCode.PAYLOAD_PARSE_ERROR);

    expect(new ConfigurationError('K', 'x').httpStatus).toBe(500);
    expect(errorCodeForStatus(500)).not.toBe(ErrorCode.CONFIGURATION_ERROR);
  });
});

describe('narrowing and retry helpers', () => {
  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a bare object', { code: 'RESOURCE_NOT_FOUND' }],
  ])('isGoSumoError rejects %s', (_label, value) => {
    expect(isGoSumoError(value)).toBe(false);
  });

  it('isRetryableError defers to a typed error', () => {
    expect(isRetryableError(new RateLimitExceededError('x'))).toBe(true);
    expect(isRetryableError(new ValidationError('x'))).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
  ])('isRetryableError defaults %s to retryable', (_label, value) => {
    // An unclassifiable throwable must not silently cancel a caller's retry.
    expect(isRetryableError(value)).toBe(true);
  });

  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a typed error', new ValidationError('bad budget'), 'bad budget'],
    ['a string', 'raw string', 'raw string'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, '42'],
  ])('errorMessage renders %s', (_label, value, expected) => {
    expect(errorMessage(value)).toBe(expected);
  });
});
