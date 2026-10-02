/**
 * friendlyError / isRetryable — the copy an operator actually reads when
 * something fails.
 *
 * The tests are grouped by what the reader learns, not by status code, because
 * the point of the mapper is that each failure tells them what to do next:
 * check the connection, sign in again, ask an admin, or just retry. The
 * "leaks" suite is the important one — it pins that developer-facing strings
 * never reach a small-business owner's screen.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client';
import { friendlyError, isRetryable } from './errors';

const GENERIC = 'Something went wrong on our end. Please try again in a moment.';

describe('friendlyError — offline and unreachable', () => {
  it('tells the reader to check their connection when fetch never got a response', () => {
    const err = new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the DoAide Desk API. Is it running?');
    expect(friendlyError(err)).toBe(
      'Can’t reach DoAide Desk. Check your internet connection and try again.',
    );
  });

  it('never shows the api-client’s developer-facing "Is it running?" copy', () => {
    const err = new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the DoAide Desk API. Is it running?');
    expect(friendlyError(err)).not.toMatch(/Is it running/);
  });

  it('treats a raw fetch rejection as offline too', () => {
    expect(friendlyError(new TypeError('Failed to fetch'))).toMatch(/internet connection/);
    expect(friendlyError(new Error('NetworkError when attempting to fetch resource'))).toMatch(
      /internet connection/,
    );
  });

  it('honours a NETWORK_ERROR code even if the status is not 0', () => {
    expect(friendlyError(new ApiError(500, 'NETWORK_ERROR', 'boom'))).toMatch(
      /internet connection/,
    );
  });
});

describe('friendlyError — auth and permissions', () => {
  it('tells the reader to sign in again on 401', () => {
    expect(friendlyError(new ApiError(401, 'UNAUTHORIZED', 'Unauthorized'))).toBe(
      'Your session has expired. Please sign in again to continue.',
    );
  });

  it('tells the reader who to ask on 403, rather than implying a bug', () => {
    const msg = friendlyError(new ApiError(403, 'FORBIDDEN', 'Forbidden'));
    expect(msg).toMatch(/don’t have permission/);
    expect(msg).toMatch(/admin/);
  });

  it('does not offer a retry for failures a retry cannot fix', () => {
    expect(isRetryable(new ApiError(403, 'FORBIDDEN', 'Forbidden'))).toBe(false);
    expect(isRetryable(new ApiError(404, 'NOT_FOUND', 'Not Found'))).toBe(false);
  });

  it('does offer a retry for transient failures', () => {
    expect(isRetryable(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(true);
    expect(isRetryable(new ApiError(500, 'ERROR', 'x'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe(true);
    expect(isRetryable(new Error('anything'))).toBe(true);
  });
});

describe('friendlyError — missing, conflicting and rejected data', () => {
  it('explains a 404 as deleted or moved', () => {
    expect(friendlyError(new ApiError(404, 'NOT_FOUND', 'Not Found'))).toMatch(
      /may have been deleted or moved/,
    );
  });

  it('explains a 409 as a concurrent edit', () => {
    expect(friendlyError(new ApiError(409, 'CONFLICT', 'Conflict'))).toMatch(
      /Someone else changed this/,
    );
  });

  it('prefers the server’s reason on a 409, since the API knows what clashed', () => {
    expect(
      friendlyError(new ApiError(409, 'CONFLICT', 'This unit is already held by another broker.')),
    ).toBe('This unit is already held by another broker.');
  });

  it('prefers the server’s reason on a validation failure', () => {
    expect(
      friendlyError(new ApiError(422, 'VALIDATION_ERROR', 'Phone number must be 10 digits.')),
    ).toBe('Phone number must be 10 digits.');
    expect(friendlyError(new ApiError(400, 'BAD_REQUEST', 'Start date must be before end date.'))).toBe(
      'Start date must be before end date.',
    );
  });

  it('falls back to generic validation copy when the server said nothing useful', () => {
    expect(friendlyError(new ApiError(422, 'VALIDATION_ERROR', 'Bad Request'))).toMatch(
      /weren’t accepted/,
    );
  });
});

describe('friendlyError — server trouble and rate limits', () => {
  it('asks the reader to wait on 429', () => {
    expect(friendlyError(new ApiError(429, 'RATE_LIMITED', 'Too Many Requests'))).toMatch(
      /wait a few seconds/,
    );
  });

  it('says DoAide Desk is temporarily unavailable on 503', () => {
    expect(friendlyError(new ApiError(503, 'UNAVAILABLE', 'Service Unavailable'))).toMatch(
      /temporarily unavailable/,
    );
  });

  it('explains a timeout on 408 and 504', () => {
    expect(friendlyError(new ApiError(408, 'TIMEOUT', 'Timeout'))).toMatch(/took too long/);
    expect(friendlyError(new ApiError(504, 'TIMEOUT', 'Gateway Timeout'))).toMatch(/took too long/);
  });

  it('uses the caller’s fallback for a 500, so the surface can name what failed', () => {
    expect(friendlyError(new ApiError(500, 'ERROR', 'Internal Server Error'), 'Could not load approvals.')).toBe(
      'Could not load approvals.',
    );
  });

  it('uses generic copy for a 500 when the surface offered no fallback', () => {
    expect(friendlyError(new ApiError(500, 'ERROR', 'Internal Server Error'))).toBe(GENERIC);
  });
});

describe('friendlyError — never leaks developer-facing text', () => {
  it('drops the api-client’s "Request failed with status N" placeholder', () => {
    const msg = friendlyError(new ApiError(500, 'ERROR', 'Request failed with status 500'));
    expect(msg).not.toMatch(/status 500/);
    expect(msg).toBe(GENERIC);
  });

  it('drops bare framework status words instead of showing them as a sentence', () => {
    for (const bare of ['Bad Request', 'Unauthorized', 'Forbidden', 'Not Found', 'Conflict', 'Internal Server Error']) {
      expect(friendlyError(new Error(bare))).toBe(GENERIC);
    }
  });

  it('drops stack-ish and socket-level strings', () => {
    expect(friendlyError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(GENERIC);
    expect(friendlyError(new Error('socket hang up'))).toBe(GENERIC);
    expect(friendlyError(new Error('TypeError: x is not a function at Module.foo'))).toBe(GENERIC);
  });

  it('drops internal error class names like PrismaClientKnownRequestError', () => {
    expect(friendlyError(new Error('PrismaClientKnownRequestError: Invalid `prisma.query`'))).toBe(GENERIC);
    expect(friendlyError(new Error('ValidationError: body.name should not be empty'))).toBe(GENERIC);
  });

  it('drops whitespace-only server messages', () => {
    expect(friendlyError(new ApiError(400, 'BAD_REQUEST', '   '))).toMatch(/weren’t accepted/);
  });
});

describe('friendlyError — non-Error inputs', () => {
  it('passes through a meaningful string', () => {
    expect(friendlyError('Your trial has ended.')).toBe('Your trial has ended.');
  });

  it('falls back for null, undefined and objects', () => {
    expect(friendlyError(null)).toBe(GENERIC);
    expect(friendlyError(undefined)).toBe(GENERIC);
    expect(friendlyError({ weird: true })).toBe(GENERIC);
    expect(friendlyError(null, 'Could not load leads.')).toBe('Could not load leads.');
  });

  it('does not report an aborted request as a failure worth explaining', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(friendlyError(abort, 'Could not load leads.')).toBe('Could not load leads.');
  });

  it('keeps a genuine Error message that reads like a sentence', () => {
    expect(friendlyError(new Error('Your plan does not include WhatsApp.'))).toBe(
      'Your plan does not include WhatsApp.',
    );
  });

  it('falls back to generic copy for an abort with nothing better to say', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(friendlyError(abort)).toBe(GENERIC);
  });

  it('does not show a developer-facing string just because it arrived bare', () => {
    // A raw string is the least structured input the mapper takes; it still has
    // to be filtered, or transport noise reaches the reader unmapped.
    expect(friendlyError('Request failed with status 500')).toBe(GENERIC);
    expect(friendlyError('Internal Server Error', 'Could not load payments.')).toBe(
      'Could not load payments.',
    );
  });
});

describe('friendlyError — statuses with no mapping of their own', () => {
  it('shows the server’s reason for an unmapped 4xx, since only it knows why', () => {
    // 402 has no hand-written copy. The API is the only thing that can explain
    // a payment-required refusal, so its text is preferred over generic copy.
    expect(friendlyError(new ApiError(402, 'PAYMENT_REQUIRED', 'Your subscription lapsed.'))).toBe(
      'Your subscription lapsed.',
    );
  });

  it('falls back to generic copy for an unmapped 4xx that explained nothing', () => {
    expect(friendlyError(new ApiError(418, 'TEAPOT', 'Request failed with status 418'))).toBe(
      GENERIC,
    );
  });

  it('treats an empty server message the same as no message at all', () => {
    expect(friendlyError(new ApiError(400, 'BAD_REQUEST', ''))).toMatch(/weren’t accepted/);
  });

  it('uses the caller’s fallback for an unmapped status, not the server’s noise', () => {
    expect(friendlyError(new ApiError(418, 'TEAPOT', ''), 'Could not load bookings.')).toBe(
      'Could not load bookings.',
    );
  });
});
