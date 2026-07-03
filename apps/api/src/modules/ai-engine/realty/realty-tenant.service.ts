import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma.service';

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

/** How long a resolved realty-tenant verdict stays cached (ms). */
export const REALTY_TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Profile-config values that mark a business as a realty tenant explicitly. */
const REALTY_VERTICALS = new Set(['realty', 'real_estate', 'real-estate']);

/**
 * RealtyTenantService — decides whether a business runs on the GoSumo Realty
 * vertical, so the inbound message pipeline can route realty tenants to the
 * grounded realty AI loop and leave everyone else on the generic `ai-engine`.
 *
 * This is a deliberately dependency-light leaf (PrismaService only) so BOTH the
 * generic `AiEngineService` and the realty `RealtyMessageBridgeService` can
 * consume it without creating a module cycle.
 *
 * Detection, in priority order:
 *   1. Explicit config — `businesses.profile.vertical` (authoritative both ways;
 *      onboarding sets this, and it lets ops force a business on/off the vertical).
 *   2. Realty footprint — an autonomy-dial row (`realty_account_settings`) or any
 *      captured realty lead/project. All three tables are realty-exclusive, so
 *      their presence is a safe positive signal.
 *
 * Verdicts are cached per business (short TTL) because this runs on the hot path
 * of every inbound message. `invalidate()` drops a cached verdict when a business
 * flips vertical (e.g. mid-onboarding).
 */
@Injectable()
export class RealtyTenantService {
  private readonly logger = new Logger(RealtyTenantService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** Whether `businessId` is a GoSumo Realty tenant. Fails closed (false) on error. */
  async isRealtyTenant(businessId: string): Promise<boolean> {
    if (!businessId) return false;

    const cached = this.cache.get(businessId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: boolean;
    try {
      value = await this.resolve(businessId);
    } catch (err) {
      // Never let a classification hiccup stall message processing; fall back to
      // the generic pipeline and do NOT cache a transient failure.
      this.logger.warn(
        `Realty-tenant check failed for ${businessId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    this.cache.set(businessId, { value, expiresAt: Date.now() + REALTY_TENANT_CACHE_TTL_MS });
    return value;
  }

  /** Drop a cached verdict — call after a business changes vertical. */
  invalidate(businessId: string): void {
    this.cache.delete(businessId);
  }

  private async resolve(businessId: string): Promise<boolean> {
    const business = await this.prisma.businesses.findFirst({
      where: { id: businessId, deleted_at: null },
      select: { profile: true },
    });
    if (!business) return false;

    // 1) Explicit opt-in / opt-out via business profile config wins outright.
    const profile = (business.profile ?? {}) as Record<string, unknown>;
    const rawVertical = profile['vertical'];
    if (typeof rawVertical === 'string' && rawVertical.trim() !== '') {
      return REALTY_VERTICALS.has(rawVertical.trim().toLowerCase());
    }

    // 2) Otherwise infer from a realty footprint. Any one is sufficient.
    const [settings, lead, project] = await Promise.all([
      this.prisma.realty_account_settings.findUnique({
        where: { business_id: businessId },
        select: { business_id: true },
      }),
      this.prisma.realty_leads.findFirst({
        where: { business_id: businessId, deleted_at: null },
        select: { id: true },
      }),
      this.prisma.realty_projects.findFirst({
        where: { business_id: businessId, deleted_at: null },
        select: { id: true },
      }),
    ]);

    return Boolean(settings || lead || project);
  }
}
