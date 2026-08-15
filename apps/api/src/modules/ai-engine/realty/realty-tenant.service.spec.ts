import { PrismaService } from '../../../common/services/prisma.service';
import { RealtyTenantService } from './realty-tenant.service';

/**
 * RealtyTenantService — the realty-vs-generic classifier that gates which AI
 * pipeline owns an inbound message. Explicit `profile.vertical` config wins;
 * otherwise a realty footprint (account settings / lead / project) is inferred.
 * Verdicts are cached per business to keep the hot path cheap.
 */
describe('RealtyTenantService', () => {
  let businesses: { findFirst: jest.Mock };
  let accountSettings: { findUnique: jest.Mock };
  let leads: { findFirst: jest.Mock };
  let projects: { findFirst: jest.Mock };
  let service: RealtyTenantService;

  function build() {
    businesses = { findFirst: jest.fn().mockResolvedValue({ profile: {} }) };
    accountSettings = { findUnique: jest.fn().mockResolvedValue(null) };
    leads = { findFirst: jest.fn().mockResolvedValue(null) };
    projects = { findFirst: jest.fn().mockResolvedValue(null) };
    const prisma = {
      businesses,
      realty_account_settings: accountSettings,
      realty_leads: leads,
      realty_projects: projects,
    } as unknown as PrismaService;
    service = new RealtyTenantService(prisma);
  }

  beforeEach(build);

  describe('explicit profile.vertical config wins outright', () => {
    it('returns true for a realty vertical without touching the footprint', async () => {
      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'realty' } });

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
      expect(accountSettings.findUnique).not.toHaveBeenCalled();
      expect(leads.findFirst).not.toHaveBeenCalled();
    });

    it('accepts real_estate / real-estate spellings (case-insensitive)', async () => {
      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'Real_Estate' } });
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });

    it('returns false for a non-realty vertical even if realty data exists', async () => {
      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'ecommerce' } });
      leads.findFirst.mockResolvedValue({ id: 'lead-1' });

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);
      // Explicit opt-out short-circuits the footprint lookup.
      expect(leads.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('footprint inference when no vertical is set', () => {
    it('is a realty tenant when an autonomy-dial row exists', async () => {
      accountSettings.findUnique.mockResolvedValue({ business_id: 'biz-1' });
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });

    it('is a realty tenant when a captured lead exists', async () => {
      leads.findFirst.mockResolvedValue({ id: 'lead-1' });
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });

    it('is a realty tenant when a project exists', async () => {
      projects.findFirst.mockResolvedValue({ id: 'proj-1' });
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });

    it('is NOT a realty tenant with no config and no footprint', async () => {
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);
    });
  });

  it('returns false for an unknown / soft-deleted business', async () => {
    businesses.findFirst.mockResolvedValue(null);
    await expect(service.isRealtyTenant('ghost')).resolves.toBe(false);
  });

  it('treats a business with no profile at all as unclassified, not as a crash', async () => {
    // `profile` is nullable, and the classifier indexes into it. Without the
    // `?? {}` this throws — and the throw lands in the catch below, which
    // degrades every message from that tenant to the generic pipeline
    // permanently rather than falling through to the footprint check.
    businesses.findFirst.mockResolvedValue({ profile: null });
    leads.findFirst.mockResolvedValue({ id: 'lead-1' });

    await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
  });

  it('falls back to the generic pipeline when the lookup rejects with a non-Error', async () => {
    // A driver rejection can be a bare string. The warn path stringifies
    // instead of reading `.message`, which would throw inside the catch and
    // propagate into message processing — the thing this guard exists to stop.
    businesses.findFirst.mockRejectedValueOnce('connection terminated');
    await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);
  });

  it('does not cache a transient failure', async () => {
    // Caching a hiccup would strand a real realty tenant on the generic
    // pipeline for the whole TTL.
    businesses.findFirst.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);

    businesses.findFirst.mockResolvedValue({ profile: { vertical: 'realty' } });
    await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
  });

  it('returns false for an empty businessId without querying', async () => {
    await expect(service.isRealtyTenant('')).resolves.toBe(false);
    expect(businesses.findFirst).not.toHaveBeenCalled();
  });

  describe('caching', () => {
    it('caches a verdict — a second call within TTL hits no DB', async () => {
      leads.findFirst.mockResolvedValue({ id: 'lead-1' });

      await service.isRealtyTenant('biz-1');
      await service.isRealtyTenant('biz-1');

      expect(businesses.findFirst).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces a fresh lookup', async () => {
      await service.isRealtyTenant('biz-1'); // false, cached
      service.invalidate('biz-1');
      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'realty' } });

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
      expect(businesses.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure handling', () => {
    it('fails closed (false) and does not cache a transient error', async () => {
      businesses.findFirst.mockRejectedValueOnce(new Error('db down'));

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);

      // Next call retries (nothing was cached) and can succeed.
      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'realty' } });
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });
  });

  /**
   * `invalidate()` existed and nothing ever called it, so the only thing that
   * cleared a verdict was the 5-minute TTL — and the verdict that goes stale is
   * the negative one. A business becomes a realty tenant by capturing its first
   * lead or project, and until this listener existed every message in the five
   * minutes after that went to the generic assistant: no BLTC qualification, no
   * verified fact sheets, no realty guardrails. Self-healing, which is exactly
   * why it would never have been reported as a bug.
   */
  describe('cache invalidation on the events that change the answer', () => {
    it('drops a cached "not realty" when the tenant captures its first lead', async () => {
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);

      // The footprint that makes branch 2 true now exists.
      leads.findFirst.mockResolvedValue({ id: 'lead-1' });
      service.handleFootprintChanged({ businessId: 'biz-1' });

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
      expect(businesses.findFirst).toHaveBeenCalledTimes(2);
    });

    it('drops a cached verdict when the business profile is edited', async () => {
      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(false);

      businesses.findFirst.mockResolvedValue({ profile: { vertical: 'realty' } });
      service.handleFootprintChanged({ businessId: 'biz-1' });

      await expect(service.isRealtyTenant('biz-1')).resolves.toBe(true);
    });

    it('invalidates only the business named on the event', async () => {
      await service.isRealtyTenant('biz-1');
      await service.isRealtyTenant('biz-2');
      businesses.findFirst.mockClear();

      service.handleFootprintChanged({ businessId: 'biz-1' });

      await service.isRealtyTenant('biz-1');
      await service.isRealtyTenant('biz-2');
      // Only biz-1 re-resolved; biz-2 is still served from its cached verdict.
      expect(businesses.findFirst).toHaveBeenCalledTimes(1);
      expect(businesses.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'biz-1' }) }),
      );
    });

    it('ignores an event with no businessId rather than throwing on the event bus', async () => {
      await service.isRealtyTenant('biz-1');
      expect(() => service.handleFootprintChanged({})).not.toThrow();
      expect(() =>
        service.handleFootprintChanged(undefined as unknown as { businessId?: string }),
      ).not.toThrow();

      // Nothing was dropped.
      businesses.findFirst.mockClear();
      await service.isRealtyTenant('biz-1');
      expect(businesses.findFirst).not.toHaveBeenCalled();
    });

    it('is registered for all three events that can change the verdict', () => {
      // The listeners are what make `invalidate()` reachable at all; a
      // decorator dropped in a refactor would leave the method dead again.
      const registered = Reflect.getMetadata(
        'EVENT_LISTENER_METADATA',
        RealtyTenantService.prototype.handleFootprintChanged,
      ) as Array<{ event: string }> | undefined;

      expect((registered ?? []).map((l) => l.event).sort()).toEqual([
        'business.settings.updated',
        'realty.lead.created',
        'realty.project.created',
      ]);
    });
  });
});
