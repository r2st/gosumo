import { SetMetadata } from '@nestjs/common';

/** Metadata key carrying a route's deprecation notice. */
export const API_DEPRECATION = 'api_deprecation';

/** A route's deprecation, as declared on the handler. */
export interface DeprecationNotice {
  /**
   * When the route was announced as deprecated. ISO-8601 date or datetime.
   *
   * Not "when it stops working" — that is `sunset`. Both are needed: a client
   * that started integrating last week needs to know the clock has been
   * running for six months already.
   */
  since: string;

  /**
   * When the route stops working. ISO-8601. Optional, because "deprecated
   * with no removal date yet" is an honest state and is better said than
   * faked with a placeholder.
   */
  sunset?: string;

  /**
   * The path that replaces it, e.g. `/v1/search/messages`. Emitted as a
   * `successor-version` link relation (RFC 5829).
   *
   * The single most useful field here. "This is deprecated" without "use that
   * instead" moves the work of finding the replacement onto every client
   * independently.
   */
  replacement?: string;

  /** One line for a human reading the logs or the docs page. */
  reason?: string;

  /**
   * Refuse the request with 410 Gone once `sunset` has passed.
   *
   * **Off by default, and it should stay off until somebody decides
   * otherwise for a specific route.** A date in a source file that silently
   * starts returning 410 is a production outage scheduled by a constant, and
   * it fires on the day nobody is watching — not on the day somebody chose.
   * Turning it on is how a deprecation actually completes rather than
   * accumulating forever, but it is a deliberate act with an owner.
   */
  enforceSunset?: boolean;
}

/**
 * `@ApiDeprecated({ since: '2026-08-15', sunset: '2027-02-15', replacement: '…' })`
 *
 * Marks a route as deprecated. `DeprecationInterceptor` turns this into the
 * standard response headers, so a client learns about it from the API itself
 * rather than from a changelog nobody subscribes to.
 *
 * Applies to a method or a whole controller; the method wins when both carry
 * one, which is what lets a controller be deprecated wholesale while one route
 * on it keeps a different sunset.
 */
export const ApiDeprecated = (notice: DeprecationNotice): MethodDecorator & ClassDecorator =>
  SetMetadata(API_DEPRECATION, notice);
