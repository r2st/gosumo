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
});
