import {
  Injectable,
  NestMiddleware,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Request augmented with resolved tenant context.
 */
export interface TenantScopedRequest extends Request {
  user?: { businessId?: string; sub?: string; role?: string };
  tenantId?: string;
  tenantContext?: { businessId: string };
}

/**
 * Path prefixes that are exempt from tenant isolation. These are either public
 * (webhooks verify their own signatures; auth issues the first token) or
 * platform-level (health, docs, admin uses its own scoping).
 */
const EXEMPT_PREFIXES: readonly string[] = [
  'webhooks',
  'v1/webhooks',
  'auth',
  'v1/auth',
  'health',
  'v1/health',
  'v1/docs',
  'queues',
  'v1/queues',
];

/**
 * TenantIsolationMiddleware — application-edge enforcement of multi-tenant
 * isolation (the middleware layer of GoSumo's defence-in-depth model, sitting
 * above PostgreSQL RLS).
 *
 * For every non-exempt request it:
 *  1. Resolves the caller's `businessId` from `request.user` (set by the JWT
 *     strategy) or, as a fallback, from the unverified JWT payload in the
 *     Authorization header. Signature verification remains the auth guard's job.
 *  2. Rejects requests with no resolvable tenant (401).
 *  3. Rejects any request whose body/query/params carry a *different*
 *     `businessId` than the token's — a forged cross-tenant access attempt (403).
 *  4. Attaches `request.tenantId` and `request.tenantContext` for downstream
 *     handlers and repositories to scope every query.
 */
@Injectable()
export class TenantIsolationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantIsolationMiddleware.name);

  use(req: TenantScopedRequest, _res: Response, next: NextFunction): void {
    if (this.isExempt(req.originalUrl)) {
      next();
      return;
    }

    const businessId = this.resolveBusinessId(req);
    if (!businessId) {
      throw new UnauthorizedException('Tenant context could not be resolved from request');
    }

    this.assertNoCrossTenantForgery(req, businessId);

    req.tenantId = businessId;
    req.tenantContext = { businessId };
    next();
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private isExempt(path: string): boolean {
    const normalized = path.replace(/^\/+/, '').toLowerCase();
    return EXEMPT_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
  }

  /**
   * Resolve businessId: prefer the verified `request.user`, fall back to
   * decoding (not verifying) the bearer token payload.
   */
  private resolveBusinessId(req: TenantScopedRequest): string | undefined {
    const fromUser = req.user?.businessId;
    if (fromUser) {
      return fromUser;
    }
    return this.decodeBusinessIdFromAuthHeader(req);
  }

  private decodeBusinessIdFromAuthHeader(req: TenantScopedRequest): string | undefined {
    const header = req.headers['authorization'];
    if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
      return undefined;
    }
    const token = header.slice('Bearer '.length).trim();
    const parts = token.split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    try {
      const payloadPart = parts[1];
      if (!payloadPart) {
        return undefined;
      }
      const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
      const payload = JSON.parse(json) as { businessId?: string };
      return typeof payload.businessId === 'string' ? payload.businessId : undefined;
    } catch {
      // Malformed token payload — let the auth guard produce the canonical 401.
      return undefined;
    }
  }

  /**
   * If any request-supplied `businessId` disagrees with the token's, this is a
   * cross-tenant access attempt — reject it.
   */
  private assertNoCrossTenantForgery(req: TenantScopedRequest, businessId: string): void {
    const claimed = [
      this.pickBusinessId(req.body),
      this.pickBusinessId(req.query),
      this.pickBusinessId(req.params),
    ].filter((v): v is string => typeof v === 'string');

    for (const value of claimed) {
      if (value !== businessId) {
        this.logger.warn(
          `Cross-tenant access blocked: token tenant ${businessId} vs requested ${value}`,
        );
        throw new ForbiddenException('Cross-tenant access is not permitted');
      }
    }
  }

  private pickBusinessId(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }
    const record = source as Record<string, unknown>;
    const value = record['businessId'];
    return typeof value === 'string' ? value : undefined;
  }
}
