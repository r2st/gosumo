/**
 * The API's versioning scheme, in one place.
 *
 * There is exactly one version and it lives in the URL path, applied once in
 * `main.ts` via `app.setGlobalPrefix(API_VERSION)`. Every controller declares
 * its path *without* it — `@Controller('conversations')`, not
 * `@Controller('v1/conversations')` — because the prefix is added on top of
 * whatever the controller says. A controller that includes it produces
 * `/v1/v1/conversations`, which 404s and is invisible until somebody calls
 * that one route. `api-versioning-contract.spec.ts` is what catches it.
 */

/** The current API version. Also the global route prefix. */
export const API_VERSION = 'v1';

/**
 * Path segments that must never begin a controller's own path.
 *
 * Broader than just the current version: the mistake this catches is
 * "somebody wrote the version into a controller", and the person who adds
 * `v2/` is more likely to make it than the person who has been writing `v1`
 * routes all along.
 */
export const RESERVED_PATH_PREFIXES: readonly string[] = ['v1', 'v2', 'api'];

/**
 * How a version is retired.
 *
 * Not a policy anyone can enforce from a constants file, but the numbers a
 * deprecation should be written against, so three different routes do not get
 * three different grace periods invented on the spot.
 */
export const DEPRECATION_POLICY = {
  /** Minimum notice between announcing a deprecation and its sunset. */
  minimumNoticeDays: 180,
  /** Where the deprecation notes live, linked from every deprecated response. */
  documentationUrl: 'https://gosumo.aiknol.com/docs/api/deprecations',
} as const;
