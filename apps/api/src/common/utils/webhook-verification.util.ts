import * as crypto from 'crypto';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared fail-closed rule for webhook signature verification.
 *
 * Adapters can only verify a signature when their channel secret is
 * configured. Historically each adapter answered a missing secret by
 * returning `true` — convenient in local dev, but it means a single missing
 * or misspelled env var in production silently turns every inbound webhook
 * endpoint into an unauthenticated write path: anyone who knows the URL can
 * forge customer messages into a tenant's inbox.
 *
 * Root rule (CLAUDE.md #3) is that signatures are always verified, so the
 * skip is confined to non-production environments and is loud when it
 * happens. In production a missing secret rejects the request.
 */

/** True when the API is running with NODE_ENV=production. */
export function isProductionEnv(configService: ConfigService): boolean {
  return configService.get<string>('app.env', 'development') === 'production';
}

/**
 * Decide whether a webhook may be accepted when its signature could not be
 * verified for a configuration reason (not a bad signature — that is always
 * a rejection).
 *
 * @returns `true` only outside production, where it also emits a warning.
 */
export function allowUnverifiedWebhook(
  logger: Logger,
  isProduction: boolean,
  reason: string,
): boolean {
  if (isProduction) {
    logger.error(
      `Webhook rejected: ${reason}. Refusing to accept unverified webhooks in production.`,
    );
    return false;
  }

  logger.warn(
    `Webhook signature verification skipped — ${reason}. ` +
      `This is permitted outside production only.`,
  );
  return true;
}

/**
 * HMAC-SHA256 verification for channels whose provider has no signature scheme
 * of its own.
 *
 * WhatsApp, Instagram and Twilio each define how their webhooks are signed, and
 * their adapters implement that scheme. Email relays and the hosted web-chat
 * widget do not — whatever forwards a parsed email or a widget message to us is
 * infrastructure we configure, so we get to pick. This is that scheme: the
 * sender HMACs the exact request bytes with a shared secret and puts the hex
 * digest in a header.
 *
 * Two details are load-bearing:
 *
 *   - It signs `rawBody`, not the parsed body. `JSON.stringify(req.body)` is not
 *     the bytes the sender signed — key order and whitespace differ — so a
 *     re-serialized check either never matches or gets quietly written to always
 *     match.
 *   - It compares with `timingSafeEqual`. A `===` on a digest exits at the first
 *     wrong byte, and that timing difference is enough to recover the expected
 *     value one byte at a time.
 *
 * A missing secret is a configuration problem, so it goes through
 * `allowUnverifiedWebhook` and fails closed in production. A missing or wrong
 * signature is an authentication failure and is always a rejection.
 */
export function verifySharedSecretSignature(options: {
  logger: Logger;
  isProduction: boolean;
  /** The configured shared secret. Empty means "not configured". */
  secret: string;
  /** Header name carrying the hex digest, e.g. `x-gosumo-signature`. */
  headerName: string;
  headers: Record<string, string>;
  /** Exact request bytes. Absent when the app was not built with rawBody. */
  rawBody: Buffer | undefined;
  /** Names the channel in log lines, e.g. `EMAIL`. */
  channelLabel: string;
}): boolean {
  const { logger, isProduction, secret, headerName, headers, rawBody, channelLabel } =
    options;

  if (!secret) {
    return allowUnverifiedWebhook(
      logger,
      isProduction,
      `no inbound webhook secret is configured for ${channelLabel}`,
    );
  }

  const provided = headers[headerName.toLowerCase()] ?? '';
  if (!provided) {
    logger.warn(`${channelLabel} webhook rejected: missing ${headerName} header`);
    return false;
  }

  if (!rawBody || rawBody.length === 0) {
    // Without the original bytes there is nothing to verify against. Treated as
    // a configuration fault (the app must be created with `rawBody: true`)
    // rather than a bad signature, so it is loud in dev and closed in prod.
    return allowUnverifiedWebhook(
      logger,
      isProduction,
      `${channelLabel} webhook arrived without a raw body to verify`,
    );
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    logger.warn(`${channelLabel} webhook rejected: signature length mismatch`);
    return false;
  }

  const isValid = crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  if (!isValid) {
    logger.warn(`${channelLabel} webhook rejected: signature mismatch`);
  }
  return isValid;
}

/**
 * Constant-time equality for a shared secret presented by a caller — the
 * Meta `hub.verify_token`, the portal ingest token, and anything else compared
 * against a configured string rather than a computed digest.
 *
 * Two properties that a plain `===` does not give:
 *
 *  1. **Fail closed on an unconfigured secret.** When `expected` is empty,
 *     `provided === expected` is *true* for a caller who simply sends nothing,
 *     so a missing env var turns the check into a rubber stamp rather than a
 *     locked door. An unset secret can never match here.
 *  2. **No early exit.** `===` on a string stops at the first differing byte,
 *     which leaks the length of the matching prefix — the same reason the HMAC
 *     path above uses `timingSafeEqual`. A shared secret deserves it more than
 *     a digest does, since the secret is long-lived and the digest is not.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * that comparison leaks only the length, never the contents.
 */
export function secretsMatch(provided: string | undefined | null, expected: string): boolean {
  if (!expected || !provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
