/**
 * clientIp unit tests.
 *
 * This helper is the grouping key for every auth throttle window and the `ip`
 * column on every session record, so the ways it can silently collapse callers
 * together — an unparsed `X-Forwarded-For` list, an array-shaped header, an
 * empty string treated as a value — are what these cases pin down.
 */

import { clientIp, IpBearingRequest } from './client-ip.util';

const req = (r: Partial<IpBearingRequest>): IpBearingRequest => r as IpBearingRequest;

describe('clientIp', () => {
  it('takes the first entry of a comma-separated X-Forwarded-For', () => {
    // The client is first; everything after it is a proxy that handled the hop.
    expect(
      clientIp(req({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' } })),
    ).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace from the chosen entry', () => {
    expect(clientIp(req({ headers: { 'x-forwarded-for': '  203.0.113.7 , 10.0.0.1' } }))).toBe(
      '203.0.113.7',
    );
  });

  it('handles a single-value X-Forwarded-For with no list', () => {
    expect(clientIp(req({ headers: { 'x-forwarded-for': '203.0.113.7' } }))).toBe('203.0.113.7');
  });

  it('handles the array shape Express uses for a repeated header', () => {
    expect(
      clientIp(req({ headers: { 'x-forwarded-for': ['203.0.113.7, 10.0.0.1', '10.0.0.2'] } })),
    ).toBe('203.0.113.7');
  });

  it('falls back to req.ip when the header is absent', () => {
    expect(clientIp(req({ headers: {}, ip: '198.51.100.4' }))).toBe('198.51.100.4');
  });

  it('falls back to req.ip when the header is present but empty', () => {
    // An empty header must not beat a real address, or a client could erase
    // itself from every throttle window by sending `X-Forwarded-For: `.
    expect(clientIp(req({ headers: { 'x-forwarded-for': '' }, ip: '198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
  });

  it('falls back to req.ip when the header holds only separators', () => {
    expect(clientIp(req({ headers: { 'x-forwarded-for': ' , , ' }, ip: '198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
  });

  it('falls back to the raw socket address when req.ip is unset', () => {
    expect(clientIp(req({ headers: {}, socket: { remoteAddress: '192.0.2.9' } }))).toBe(
      '192.0.2.9',
    );
  });

  it('returns null when nothing identifies the caller', () => {
    // Callers must treat null as "unkeyable", not as a shared bucket.
    expect(clientIp(req({ headers: {} }))).toBeNull();
    expect(clientIp(req({}))).toBeNull();
  });
});
