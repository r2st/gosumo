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
