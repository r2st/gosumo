import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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

  /**
   * Drop the verdict when the thing it was inferred from appears or changes.
   *
   * {@link invalidate} existed and nothing ever called it, so the only way a
   * stale verdict cleared was the TTL — and the stale verdict that matters is
   * the negative one. Branch 2 of {@link resolve} infers the vertical from a
   * realty footprint, and a business acquires that footprint by capturing its
   * *first* lead or project. Until that moment every inbound message caches
   * `false`, so for up to five minutes after a tenant goes live their buyers
   * are answered by the generic assistant instead of the grounded realty loop:
   * no BLTC qualification, no verified fact sheets, no realty guardrails. It is
   * self-healing, which is exactly why nobody would have found it — the tenant
   * reports "the first few replies were wrong" and by the time anyone looks it
   * is behaving.
   *
   * `business.settings.updated` is here for branch 1, the explicit
   * `profile.vertical` override an operator uses to force a business on or off
   * the vertical. That event had no listeners at all despite the ai-engine
   * module doc claiming it invalidated cached config.
   *
   * Deliberately unconditional on `changedFields`: the events carry a
   * businessId and dropping one map entry costs a `Map.delete`, so filtering
   * would only add a way to miss.
   */
  @OnEvent('realty.lead.created')
  @OnEvent('realty.project.created')
  @OnEvent('business.settings.updated')
  handleFootprintChanged(event: { businessId?: string }): void {
    if (event?.businessId) this.invalidate(event.businessId);
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
