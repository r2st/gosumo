import { ApiError } from './api-client';

/**
 * Turn any thrown value into copy a small-business owner can act on.
 *
 * The dashboard's error surfaces used to render `(error as Error).message`
 * directly, which meant operators saw transport-level strings — "Request failed
 * with status 500", "Unable to reach the DoAide Inbox API. Is it running?" — that
 * describe the system's problem rather than the reader's options. Other
 * surfaces rendered nothing at all, so a permissions problem and an outage
 * looked identical and both read "Something went wrong".
 *
 * Each message here answers two questions: what happened, and what should I do
 * about it. Server-supplied text is preferred only where the API is the
 * authority on the reason (validation and conflicts); everything else is
 * mapped, because the raw text is written for developers.
 */

/** Fallback when nothing about the failure is recognisable. */
const GENERIC = 'Something went wrong on our end. Please try again in a moment.';

/**
 * A server `message` is only worth showing when it explains a decision the
 * operator can act on. Framework defaults and stack-ish strings are not.
 */
function usableServerMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  // NestJS/Express defaults and our own transport placeholder carry no meaning.
  if (/^request failed with status/i.test(trimmed)) return undefined;
  if (/^(bad request|unauthorized|forbidden|not found|conflict|internal server error)$/i.test(trimmed))
    return undefined;
  // Anything that looks like a stack frame or a bare exception name.
  if (/\b(at\s+\w+\.|Error:|ECONNREFUSED|ETIMEDOUT|socket hang up)\b/.test(trimmed)) return undefined;
  return trimmed;
}

/** Map an HTTP status onto actionable copy. */
function messageForStatus(status: number, serverMessage?: string): string {
  // 0 is what the api-client uses when fetch itself threw — no response at all.
  if (status === 0) {
    return 'Can’t reach DoAide Inbox. Check your internet connection and try again.';
  }
  if (status === 401) {
    return 'Your session has expired. Please sign in again to continue.';
  }
  if (status === 403) {
    return 'You don’t have permission to view this. Ask a business owner or admin for access.';
  }
  if (status === 404) {
    return 'We couldn’t find this — it may have been deleted or moved.';
  }
  if (status === 408 || status === 504) {
    return 'That took too long to respond. Please try again.';
  }
  if (status === 409) {
    return serverMessage ?? 'Someone else changed this while you were working. Refresh and try again.';
  }
  if (status === 422 || status === 400) {
    return serverMessage ?? 'Some of the details weren’t accepted. Please check them and try again.';
  }
  if (status === 429) {
    return 'Too many requests right now. Please wait a few seconds and try again.';
  }
  if (status === 503) {
    return 'DoAide Inbox is temporarily unavailable. We’re on it — please try again shortly.';
  }
  if (status >= 500) {
    return GENERIC;
  }
  return serverMessage ?? GENERIC;
}

/**
 * Convert a thrown value into a user-facing sentence.
 *
 * `fallback` overrides the generic message for surfaces that can say something
 * more specific about what failed to load (e.g. "Could not load approvals.").
 * It is only used when the failure carries no better information of its own.
 */
export function friendlyError(error: unknown, fallback?: string): string {
  if (error instanceof ApiError) {
    const serverMessage = usableServerMessage(error.message);
    // NETWORK_ERROR is raised by the api-client when fetch rejects.
    if (error.code === 'NETWORK_ERROR' || error.status === 0) {
      return messageForStatus(0);
    }
    const mapped = messageForStatus(error.status, serverMessage);
    return mapped === GENERIC ? (fallback ?? GENERIC) : mapped;
  }

  if (error instanceof Error) {
    // An aborted request is a navigation artefact, not a failure worth reporting.
    if (error.name === 'AbortError') return fallback ?? GENERIC;
    // A fetch that rejects outside the api-client still reads as offline.
    if (/failed to fetch|networkerror|network request failed/i.test(error.message)) {
      return messageForStatus(0);
    }
    return usableServerMessage(error.message) ?? fallback ?? GENERIC;
  }

  if (typeof error === 'string') {
    return usableServerMessage(error) ?? fallback ?? GENERIC;
  }

  return fallback ?? GENERIC;
}

/**
 * True when retrying the same request could plausibly succeed. Permission and
 * not-found failures are terminal — offering "Try again" for them just invites
 * the operator to click a button that cannot work.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404) return false;
    return true;
  }
  return true;
}
