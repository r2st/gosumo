import {
  CallHandler,
  ExecutionContext,
  GoneException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { API_DEPRECATION, DeprecationNotice } from './deprecation.decorator';
import { DEPRECATION_POLICY } from './api-version.constants';

/**
 * DeprecationInterceptor — turns `@ApiDeprecated()` into the response headers
 * a client can act on without reading a changelog.
 *
 * Four headers, and the format of each one is load-bearing because clients
 * parse them:
 *
 *  - **`Deprecation`** — `@<epoch-seconds>`, the structured-field Date form
 *    from the IETF deprecation-header draft. Earlier drafts used an
 *    IMF-fixdate and plenty of blog posts still show `Deprecation: true`;
 *    neither parses under the current spec, and a header a client silently
 *    fails to parse is worse than no header, because it looks like it works.
 *  - **`Sunset`** — IMF-fixdate, per RFC 8594. Deliberately a *different*
 *    format from `Deprecation` above. That is not an inconsistency here; it is
 *    the two specs disagreeing, and matching each one is what makes both
 *    parse.
 *  - **`Link … rel="deprecation"`** — where to read about it.
 *  - **`Link … rel="successor-version"`** — RFC 5829, the replacement route.
 *    The most useful of the four: "deprecated" without "use this instead"
 *    moves the search onto every client independently.
 *
 * `Warning: 299` is deliberately **not** emitted. It was the conventional
 * carrier for this message for years and RFC 9111 obsoleted the whole header;
 * sending it now teaches clients to read a field the spec says to ignore.
 *
 * Headers are set **before** the handler runs, so a deprecated route that 404s
 * or throws still carries them — the exception filter writes a response onto
 * the same object. The alternative (mapping the response stream) loses the
 * notice on exactly the calls a client is most likely to be debugging.
 */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DeprecationInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const notice = this.reflector.getAllAndOverride<DeprecationNotice | undefined>(
      API_DEPRECATION,
      [context.getHandler(), context.getClass()],
    );
    if (!notice) return next.handle();

    const res = context.switchToHttp().getResponse<Response>();
    this.applyHeaders(res, notice);

    if (notice.enforceSunset && this.isPastSunset(notice)) {
      // 410, not 404: the resource existed and is gone deliberately. A 404
      // sends the caller looking for a typo in a path that used to work.
      throw new GoneException(
        `This endpoint was removed on ${notice.sunset}.` +
          (notice.replacement ? ` Use ${notice.replacement}.` : ''),
      );
    }

    return next.handle();
  }

  /** Set every header the notice supports, skipping the ones it does not. */
  private applyHeaders(res: Response, notice: DeprecationNotice): void {
    const since = this.epochSeconds(notice.since);
    if (since !== null) {
      res.setHeader('Deprecation', `@${since}`);
    } else {
      // An unparseable date is a typo in a source constant. Emitting nothing
      // is right — a malformed header is a parse error in somebody else's
      // client — but it must not be silent, because the route still looks
      // deprecated to whoever wrote the decorator.
      this.logger.warn(
        `@ApiDeprecated has an unparseable "since" value: ${notice.since}. ` +
          `No Deprecation header was sent.`,
      );
    }

    const sunsetAt = this.parseDate(notice.sunset);
    if (sunsetAt) {
      // IMF-fixdate. `toUTCString()` produces exactly that form.
      res.setHeader('Sunset', sunsetAt.toUTCString());
    } else if (notice.sunset) {
      this.logger.warn(
        `@ApiDeprecated has an unparseable "sunset" value: ${notice.sunset}. ` +
          `No Sunset header was sent.`,
      );
    }

    const links = [`<${DEPRECATION_POLICY.documentationUrl}>; rel="deprecation"; type="text/html"`];
    if (notice.replacement) {
      links.push(`<${notice.replacement}>; rel="successor-version"`);
    }
    // One header with comma-separated values, not two headers. Both are legal;
    // this form is what every client library reads back as a single list.
    res.setHeader('Link', links.join(', '));
  }

  /** True when `sunset` is set and already in the past. */
  private isPastSunset(notice: DeprecationNotice, now: Date = new Date()): boolean {
    const sunsetAt = this.parseDate(notice.sunset);
    // No sunset, or an unparseable one, means the route is not past it. Never
    // the other way round: a typo must not take a live endpoint offline.
    return sunsetAt !== null && now.getTime() >= sunsetAt.getTime();
  }

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private epochSeconds(value: string): number | null {
    const parsed = this.parseDate(value);
    return parsed === null ? null : Math.floor(parsed.getTime() / 1000);
  }
}
