/**
 * The ambient per-request context, carried on `AsyncLocalStorage`.
 *
 * The API already minted a correlation id per request and logged it on the way
 * in and the way out — but only in the interceptor that made it. Everything
 * between those two lines (every service, every repository, every event
 * listener) logged with no id at all, so the one thing a correlation id exists
 * to do — join the twenty lines a single failing request produced — did not
 * work for the eighteen lines in the middle.
 *
 * The alternative to ambient context is threading the id through every method
 * signature in the app. That is not a real option here: the id would have to
 * cross `EventEmitter` boundaries and BullMQ payloads, and the first developer
 * to add a log line without also adding a parameter puts the gap back.
 *
 * `AsyncLocalStorage` is Node's own answer and it is not a hack: the context
 * follows `await`, `setTimeout`, promise chains, and event-emitter callbacks
 * invoked synchronously within the request. What it deliberately does *not*
 * follow is a job pulled off Redis in a different process minutes later — that
 * boundary is crossed explicitly by the queue wrapper, which is why that code
 * exists separately.
 *
 * Exported as module-level functions rather than an injectable service on
 * purpose. Repositories, utilities and processors all need to read the id, and
 * making them take a constructor dependency to do it would be the same
 * signature-threading problem wearing a DI costume.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What travels with a request.
 *
 * `businessId` is here because it is the other identifier every log line in a
 * multi-tenant system wants and none of them have. It is populated by the
 * tenant layer once the JWT has been read — never from the request body, which
 * a client controls (see the app's tenancy rules).
 */
export interface RequestContext {
  correlationId: string;
  businessId?: string;
}

/**
 * One store for the process. Module-level rather than a provider so that a
 * file with no access to the Nest container can still read the context.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` attached to it and to everything it awaits.
 *
 * Returns whatever `fn` returns so it can wrap a handler transparently.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active context, or `undefined` outside any request or job. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The active correlation id, or `undefined`.
 *
 * Undefined is a normal answer, not a failure: startup, cron ticks and shell
 * scripts have no originating request. Callers format it away (see
 * {@link correlationTag}) rather than inventing an id, because an id minted
 * outside a request joins nothing and only looks like it does.
 */
export function getCorrelationId(): string | undefined {
  return getRequestContext()?.correlationId;
}

/**
 * Attach `businessId` to the context already in flight.
 *
 * Mutates rather than re-running, because by the time tenancy is resolved the
 * request is deep inside the callback `runWithRequestContext` started and there
 * is nothing left to wrap. No-ops outside a context.
 */
export function setContextBusinessId(businessId: string): void {
  const context = getRequestContext();
  if (context) context.businessId = businessId;
}

/**
 * The `[id] ` prefix used at the front of a log line, or `''` when there is no
 * context.
 *
 * Exists so callers never write `[undefined]`, which is worse than no prefix:
 * it looks like a captured id that came out wrong.
 */
export function correlationTag(): string {
  const id = getCorrelationId();
  return id ? `[${id}] ` : '';
}
