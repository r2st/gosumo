import type { Request, Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  sanitizeCorrelationId,
} from '../context/correlation-id.util';
import { getCorrelationId } from '../context/request-context';
import { correlationId } from './correlation-id.middleware';

function harness(headers: Record<string, unknown> = {}) {
  const setHeader = jest.fn();
  const req = { headers } as unknown as Request;
  const res = { setHeader } as unknown as Response;
  return { req, res, setHeader };
}

/** Run the middleware and capture what the id looked like inside `next`. */
function run(headers: Record<string, unknown> = {}) {
  const { req, res, setHeader } = harness(headers);
  let insideNext: string | undefined;
  correlationId()(req, res, () => {
    insideNext = getCorrelationId();
  });
  return { req, setHeader, insideNext };
}

describe('correlationId middleware', () => {
  it('opens a context carrying the resolved id', () => {
    expect(run({ [CORRELATION_ID_HEADER]: 'client-trace-42' }).insideNext).toBe(
      'client-trace-42',
    );
  });

  it('mints an id when the request carries none', () => {
    const { insideNext } = run();
    expect(insideNext).toBeDefined();
    expect(sanitizeCorrelationId(insideNext)).toBe(insideNext);
  });

  it('adopts the proxy-assigned x-request-id', () => {
    expect(run({ [REQUEST_ID_HEADER]: 'lb-99' }).insideNext).toBe('lb-99');
  });

  it('returns the id to the caller as a response header', () => {
    // The only way a user-visible failure ever gets joined to a log line: the
    // reporter can quote the id.
    const { setHeader } = run({ [CORRELATION_ID_HEADER]: 'abc' });
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'abc');
  });

  it('writes the resolved id back onto the request', () => {
    // What the exception filter's fallback path reads.
    const { req } = run({ [CORRELATION_ID_HEADER]: 'abc' });
    expect(req.headers[CORRELATION_ID_HEADER]).toBe('abc');
  });

  describe('a hostile inbound header', () => {
    const hostile = 'x\r\nSet-Cookie: session=stolen';

    it('never reaches the context', () => {
      const { insideNext } = run({ [CORRELATION_ID_HEADER]: hostile });
      expect(insideNext).not.toContain('\n');
      expect(sanitizeCorrelationId(insideNext)).toBe(insideNext);
    });

    it('never reaches the response header', () => {
      // A CRLF here is a response-splitting primitive, not just a messy log.
      const { setHeader } = run({ [CORRELATION_ID_HEADER]: hostile });
      const [, value] = setHeader.mock.calls[0] as [string, string];
      expect(value).not.toContain('\r');
      expect(value).not.toContain('\n');
    });

    it('is overwritten on the request, not left for a later reader', () => {
      // Anything holding the `Request` — the exception filter included — must
      // not be able to pick the raw value back up.
      const { req } = run({ [CORRELATION_ID_HEADER]: hostile });
      expect(req.headers[CORRELATION_ID_HEADER]).not.toBe(hostile);
    });
  });

  it('gives concurrent requests distinct ids', () => {
    const a = run().insideNext;
    const b = run().insideNext;
    expect(a).not.toBe(b);
  });

  it('closes the context once the request is done', () => {
    run();
    expect(getCorrelationId()).toBeUndefined();
  });
});
