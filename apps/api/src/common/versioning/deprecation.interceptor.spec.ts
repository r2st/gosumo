import { CallHandler, ExecutionContext, GoneException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { DeprecationInterceptor } from './deprecation.interceptor';
import type { DeprecationNotice } from './deprecation.decorator';
import { DEPRECATION_POLICY } from './api-version.constants';

function makeHarness(notice?: DeprecationNotice, type = 'http') {
  const headers: Record<string, unknown> = {};
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(notice),
  } as unknown as Reflector;
  const interceptor = new DeprecationInterceptor(reflector);

  const context = {
    getType: () => type,
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getResponse: () => ({
        setHeader: (name: string, value: unknown) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;

  const handled = jest.fn().mockReturnValue(of('body'));
  const next = { handle: handled } as unknown as CallHandler;

  return { interceptor, context, next, headers, handled };
}

const PAST = '2020-01-15T00:00:00.000Z';
const FUTURE = '2099-06-30T00:00:00.000Z';

describe('DeprecationInterceptor', () => {
  it('does nothing for a route with no notice', () => {
    const h = makeHarness(undefined);

    h.interceptor.intercept(h.context, h.next);

    expect(h.headers).toEqual({});
    expect(h.handled).toHaveBeenCalled();
  });

  it('does nothing outside an HTTP context', () => {
    const h = makeHarness({ since: PAST }, 'ws');

    h.interceptor.intercept(h.context, h.next);

    expect(h.headers).toEqual({});
  });

  describe('header formats', () => {
    it('sends Deprecation as a structured-field Date, not a boolean or a string date', () => {
      // The current IETF draft specifies `@<epoch-seconds>`. Older drafts used
      // an IMF-fixdate and plenty of blog posts still show `Deprecation: true`;
      // neither parses under the current spec, and a header a client silently
      // fails to parse is worse than none, because it looks like it works.
      const h = makeHarness({ since: '2026-08-15T00:00:00.000Z' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Deprecation']).toBe(`@${Date.parse('2026-08-15T00:00:00.000Z') / 1000}`);
    });

    it('sends Sunset as an IMF-fixdate, per RFC 8594', () => {
      // Deliberately a different format from Deprecation above. That is the
      // two specs disagreeing, not an inconsistency here.
      const h = makeHarness({ since: PAST, sunset: FUTURE });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Sunset']).toBe(new Date(FUTURE).toUTCString());
      expect(String(h.headers['Sunset'])).toMatch(/GMT$/);
    });

    it('links to the deprecation documentation', () => {
      const h = makeHarness({ since: PAST });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Link']).toContain(
        `<${DEPRECATION_POLICY.documentationUrl}>; rel="deprecation"`,
      );
    });

    it('links the replacement as a successor-version', () => {
      // The most useful of the four headers: "deprecated" without "use this
      // instead" moves the search onto every client independently.
      const h = makeHarness({ since: PAST, replacement: '/v1/search/messages' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Link']).toContain('</v1/search/messages>; rel="successor-version"');
    });

    it('sends one comma-separated Link header rather than two', () => {
      const h = makeHarness({ since: PAST, replacement: '/v1/x' });

      h.interceptor.intercept(h.context, h.next);

      expect(String(h.headers['Link']).split(', ')).toHaveLength(2);
    });

    it('never sends the obsolete Warning header', () => {
      // RFC 9111 obsoleted it. Sending it now teaches clients to read a field
      // the spec says to ignore.
      const h = makeHarness({ since: PAST, reason: 'replaced by full-text search' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Warning']).toBeUndefined();
    });

    it('omits Sunset entirely when there is no removal date yet', () => {
      // "Deprecated, removal date not decided" is an honest state and is
      // better said than faked with a placeholder.
      const h = makeHarness({ since: PAST });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Sunset']).toBeUndefined();
      expect(h.headers['Deprecation']).toBeDefined();
    });
  });

  describe('a typo in the notice', () => {
    it('sends no Deprecation header rather than a malformed one', () => {
      // A malformed header is a parse error in somebody else's client.
      const h = makeHarness({ since: 'sometime last year' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Deprecation']).toBeUndefined();
    });

    it('still serves the request', () => {
      const h = makeHarness({ since: 'nonsense' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.handled).toHaveBeenCalled();
    });

    it('sends no Sunset header for an unparseable sunset', () => {
      const h = makeHarness({ since: PAST, sunset: 'next spring' });

      h.interceptor.intercept(h.context, h.next);

      expect(h.headers['Sunset']).toBeUndefined();
    });
  });

  describe('sunset enforcement', () => {
    it('is off by default, so a passed sunset still serves', () => {
      // A date in a source file that silently starts returning 410 is a
      // production outage scheduled by a constant, firing on the day nobody is
      // watching rather than the day somebody chose.
      const h = makeHarness({ since: PAST, sunset: PAST });

      h.interceptor.intercept(h.context, h.next);

      expect(h.handled).toHaveBeenCalled();
    });

    it('returns 410 Gone once enabled and the sunset has passed', () => {
      // 410, not 404: the resource existed and is gone deliberately. A 404
      // sends the caller looking for a typo in a path that used to work.
      const h = makeHarness({
        since: PAST,
        sunset: PAST,
        enforceSunset: true,
        replacement: '/v1/search/messages',
      });

      expect(() => h.interceptor.intercept(h.context, h.next)).toThrow(GoneException);
      expect(h.handled).not.toHaveBeenCalled();
    });

    it('names the replacement in the 410, so the caller is not left guessing', () => {
      const h = makeHarness({
        since: PAST,
        sunset: PAST,
        enforceSunset: true,
        replacement: '/v1/search/messages',
      });

      let message = '';
      try {
        h.interceptor.intercept(h.context, h.next);
      } catch (err) {
        message = (err as GoneException).message;
      }

      expect(message).toContain('/v1/search/messages');
    });

    it('still serves while the sunset is in the future', () => {
      const h = makeHarness({ since: PAST, sunset: FUTURE, enforceSunset: true });

      h.interceptor.intercept(h.context, h.next);

      expect(h.handled).toHaveBeenCalled();
    });

    it('still serves when enforcement is on but no sunset was set', () => {
      const h = makeHarness({ since: PAST, enforceSunset: true });

      h.interceptor.intercept(h.context, h.next);

      expect(h.handled).toHaveBeenCalled();
    });

    it('does not take a live endpoint offline over an unparseable sunset', () => {
      // The one direction a typo must never resolve in.
      const h = makeHarness({ since: PAST, sunset: 'whenever', enforceSunset: true });

      h.interceptor.intercept(h.context, h.next);

      expect(h.handled).toHaveBeenCalled();
    });
  });

  it('sets the headers before the handler runs, so a failing route still carries them', () => {
    // The alternative — mapping the response stream — loses the notice on
    // exactly the calls a client is most likely to be debugging.
    const h = makeHarness({ since: PAST });
    (h.next.handle as jest.Mock).mockImplementation(() => {
      expect(h.headers['Deprecation']).toBeDefined();
      return of('body');
    });

    h.interceptor.intercept(h.context, h.next);

    expect(h.handled).toHaveBeenCalled();
  });
});
