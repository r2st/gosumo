/**
 * Rate-limit rules for the unauthenticated auth surface.
 *
 * `JwtAuthGuard` is global, so almost every route in this API is already
 * rationed by the simple fact that a caller needs a token to reach it. The
 * `@Public()` auth routes are the exception: they are reachable by anyone on
 * the internet, and each one does real work — writes a business, hashes a
 * password, sends an email. Without a ceiling, `register` mints unbounded
 * tenants and `forgot-password` turns this API into an open relay that mails
 * anybody a message, from our domain, with our reputation attached.
 *
 * The numbers below are deliberately far above what a human doing the thing
 * legitimately would ever hit, and far below what makes the endpoint useful to
 * abuse.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fixed-window ceiling: `limit` requests per `windowMs`. */
export interface ThrottleWindow {
  limit: number;
  windowMs: number;
}

export interface AuthThrottleRule {
  /**
   * Per-caller-IP ceiling. Always present — it is the only dimension available
   * before the body has been validated.
   */
  ip: ThrottleWindow;
  /**
   * Optional second ceiling keyed off a body field, applied *in addition* to
   * the IP one. An IP limit alone still lets a distributed caller hammer a
   * single victim; a subject limit alone still lets one host sweep a list of
   * addresses. Endpoints that act on somebody else's behalf need both.
   */
  subject?: ThrottleWindow & { field: string };
}

/**
 * Buckets referenced by `@AuthThrottle('<bucket>')`. A route whose bucket is
 * missing from this table is not throttled at all, which is why
 * `auth-throttle-contract.spec.ts` asserts the two sets agree.
 */
export const AUTH_THROTTLE_BUCKETS: Record<string, AuthThrottleRule> = {
  /**
   * Signup. Each success creates a business, a team member and an audit trail,
   * and none of it can be rolled back automatically — so this is the endpoint
   * where an unthrottled loop is most expensive. Five an hour is generous for
   * one person and one office behind a NAT; it is nothing to a script.
   */
  register: {
    ip: { limit: 5, windowMs: HOUR },
  },

  /**
   * Login. `AuthService` already locks an *account* after repeated failures,
   * which stops someone guessing one password. It does nothing about the
   * opposite shape — one password tried against thousands of accounts — because
   * every one of those attempts is a first failure for its account. The IP
   * ceiling is what covers that case.
   */
  login: {
    ip: { limit: 30, windowMs: 15 * MINUTE },
  },

  /**
   * Refresh-token exchange. The token is high-entropy, so guessing is not the
   * concern; the ceiling bounds what an anonymous caller can *cost* us, since
   * every attempt is a Redis lookup and a signature. Sized well above real
   * client behaviour — a 15-minute access token means roughly four refreshes
   * an hour per session, so 60 per quarter-hour still covers a whole office
   * sharing one address.
   */
  refresh: {
    ip: { limit: 60, windowMs: 15 * MINUTE },
  },

  /**
   * Password reset request. This one sends mail to an address the caller does
   * not have to own, so it needs both dimensions: the IP window stops a sweep,
   * the per-address window stops one victim being mailed repeatedly from many
   * hosts.
   */
  'forgot-password': {
    ip: { limit: 5, windowMs: 15 * MINUTE },
    subject: { field: 'email', limit: 3, windowMs: HOUR },
  },

  /**
   * Reset-token redemption. The token is high-entropy and single-use, so this
   * is not a realistic guessing target; the ceiling is here to keep the
   * bcrypt work an anonymous caller can demand bounded.
   */
  'reset-password': {
    ip: { limit: 10, windowMs: 15 * MINUTE },
  },

  /**
   * Web-chat widget bootstrap. Not an auth route — but it is `@Public()`, it
   * takes a caller-supplied channel id, and it does an unindexed-by-tenant
   * `channel_accounts` lookup on every call, which makes it the one anonymous
   * read path in this API with no ceiling of any kind on it.
   *
   * Keyed per IP, which is the right dimension here: the legitimate callers are
   * *browsers* on the sites that embed the widget, one request each per page
   * load from their own addresses. 60 a minute is far past what any real
   * visitor generates and far below what makes the endpoint worth pointing at a
   * database that this deployment shares with another service.
   */
  'webchat-embed': {
    ip: { limit: 60, windowMs: MINUTE },
  },
};

/**
 * Window bookkeeping is keyed by caller IP, so unlike the tenant-keyed
 * limiters the key space is attacker-controlled: a host cycling source
 * addresses would otherwise grow the map without bound and turn a rate limiter
 * into a memory leak. Past this many live keys the limiter sweeps expired
 * windows before admitting a new one.
 */
export const AUTH_THROTTLE_SWEEP_THRESHOLD = 10_000;
