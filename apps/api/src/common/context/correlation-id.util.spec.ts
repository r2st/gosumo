import {
  MAX_CORRELATION_ID_LENGTH,
  newCorrelationId,
  resolveCorrelationId,
  sanitizeCorrelationId,
} from './correlation-id.util';

describe('sanitizeCorrelationId', () => {
  it('accepts the id shapes real callers and proxies send', () => {
    // A UUID (ours), a W3C trace-id (32 hex), a dotted service id, and a
    // hyphenated client id — all of which should survive rather than be
    // replaced, since replacing them is what breaks the join across the hop
    // chain.
    for (const id of [
      '0f0be0c2-3018-49f0-854a-2736364fd47c',
      '4bf92f3577b34da6a3ce929d0e0e4736',
      '00f067aa0ba902b7:0000000000000001',
      'edge.gateway.7',
      'client-trace-42',
    ]) {
      expect(sanitizeCorrelationId(id)).toBe(id);
    }
  });

  it("does not accept AWS X-Ray's `Root=...` form", () => {
    /**
     * A deliberate limit, recorded so it reads as a decision rather than a
     * gap. `=` is a key/value separator to every log shipper that parses
     * `logfmt`, so accepting it would let a caller inject a field into a
     * parsed log record — the structured-logging version of the newline
     * problem. An X-Ray id therefore gets replaced with a fresh one, which
     * costs a join to X-Ray and keeps the log format intact.
     */
    expect(
      sanitizeCorrelationId('Root=1-5759e988-bd862e3fe1be46a994272793'),
    ).toBeUndefined();
  });

  it('trims surrounding whitespace rather than rejecting for it', () => {
    expect(sanitizeCorrelationId('  trace-9  ')).toBe('trace-9');
  });

  describe('log injection', () => {
    /**
     * The reason this function exists. The id is written into log lines and
     * into a response header, so a caller who can put a newline in it can
     * forge log entries — attributing text of their choosing to any component,
     * in the file the on-call reads during an incident.
     */
    it.each([
      ['CR', 'abc\rdef'],
      ['LF', 'abc\ndef'],
      ['CRLF', 'abc\r\ndef'],
      ['a forged log line', 'x\n[Nest] ERROR [AuthService] admin login succeeded'],
      ['a header split', 'x\r\nSet-Cookie: session=stolen'],
      ['an ANSI escape', 'x\x1b[2Jcleared'],
      ['a NUL byte', 'x\0y'],
    ])('rejects %s', (_label, value) => {
      expect(sanitizeCorrelationId(value)).toBeUndefined();
    });

    it('rejects characters a log shipper or dashboard would reparse', () => {
      for (const value of ['a b', 'a=b', 'a"b', '<script>', 'a,b', 'a;b']) {
        expect(sanitizeCorrelationId(value)).toBeUndefined();
      }
    });
  });

  it('rejects an id longer than the cap', () => {
    // Headers are not covered by the request body limit, so without a cap a
    // caller decides how many bytes every one of their log lines costs.
    expect(sanitizeCorrelationId('a'.repeat(MAX_CORRELATION_ID_LENGTH))).toHaveLength(
      MAX_CORRELATION_ID_LENGTH,
    );
    expect(sanitizeCorrelationId('a'.repeat(MAX_CORRELATION_ID_LENGTH + 1))).toBeUndefined();
  });

  it('rejects a repeated header, which Express surfaces as an array', () => {
    // Taking the first would let a caller smuggle a second value past a proxy
    // that inspected only one.
    expect(sanitizeCorrelationId(['a', 'b'])).toBeUndefined();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a number', 7],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeCorrelationId(value)).toBeUndefined();
  });
});

describe('resolveCorrelationId', () => {
  it('keeps a usable inbound correlation id', () => {
    expect(resolveCorrelationId('client-trace-42')).toBe('client-trace-42');
  });

  it('falls back to the proxy-assigned x-request-id', () => {
    // Caddy and most balancers set this one. Honouring it is what keeps a
    // single searchable id across the proxy and the app instead of two.
    expect(resolveCorrelationId(undefined, 'lb-99')).toBe('lb-99');
  });

  it('prefers the correlation header when both are present', () => {
    expect(resolveCorrelationId('chosen', 'ignored')).toBe('chosen');
  });

  it('mints a fresh id rather than repeating a hostile one', () => {
    const id = resolveCorrelationId('x\r\nSet-Cookie: a=b');

    expect(id).not.toContain('\r');
    expect(id).not.toContain('\n');
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  it('falls through a rejected correlation header to a valid request id', () => {
    expect(resolveCorrelationId('bad\nvalue', 'lb-99')).toBe('lb-99');
  });

  it('mints an id when nothing usable arrived', () => {
    const id = resolveCorrelationId(undefined, undefined);
    expect(sanitizeCorrelationId(id)).toBe(id);
  });
});

describe('newCorrelationId', () => {
  it('mints ids that survive its own validation and do not repeat', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();

    expect(a).not.toBe(b);
    expect(sanitizeCorrelationId(a)).toBe(a);
  });
});
