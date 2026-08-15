import { Test, TestingModule } from '@nestjs/testing';
import { BusinessController } from './business.controller';
import { TenantService } from './tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { PrismaService } from '../../common/services/prisma.service';
import type { UpdateBusinessDto } from './dto/update-business.dto';

const BIZ_ID = '11111111-1111-1111-1111-111111111111';

function makeBiz(overrides: Record<string, unknown> = {}) {
  return { id: BIZ_ID, name: 'Test Biz', email: 'test@example.com', profile: {}, ai_settings: {}, ...overrides };
}

describe('BusinessController', () => {
  let controller: BusinessController;
  let tenantService: {
    getBusinessById: jest.Mock;
    updateBusiness: jest.Mock;
    updateProfileSettings: jest.Mock;
  };
  let subscriptionService: { getSubscription: jest.Mock };
  let prisma: { businesses: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    tenantService = {
      getBusinessById: jest.fn(),
      updateBusiness: jest.fn(),
      updateProfileSettings: jest.fn(),
    };
    subscriptionService = { getSubscription: jest.fn() };
    prisma = { businesses: { findUniqueOrThrow: jest.fn(), update: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BusinessController],
      providers: [
        { provide: TenantService, useValue: tenantService },
        { provide: SubscriptionService, useValue: subscriptionService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = module.get<BusinessController>(BusinessController);
  });

  describe('getMe', () => {
    it('should return the business profile for the authenticated tenant', async () => {
      const biz = makeBiz();
      tenantService.getBusinessById.mockResolvedValue(biz);
      const result = await controller.getMe(BIZ_ID);
      expect(result).toEqual(biz);
      expect(tenantService.getBusinessById).toHaveBeenCalledWith(BIZ_ID);
    });
  });

  describe('updateMe', () => {
    it('should forward the DTO to tenantService.updateBusiness', async () => {
      const updated = makeBiz({ name: 'Updated' });
      tenantService.updateBusiness.mockResolvedValue(updated);
      const result = await controller.updateMe(BIZ_ID, { name: 'Updated' } as UpdateBusinessDto);
      expect(result).toEqual(updated);
      expect(tenantService.updateBusiness).toHaveBeenCalledWith(BIZ_ID, { name: 'Updated' });
    });
  });

  describe('getSettings', () => {
    it('should return merged settings with defaults', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue(
        makeBiz({ ai_settings: { autoReplyEnabled: false, autonomyLevel: 'MANUAL' }, profile: { settings: { officeHoursEnabled: true } } }),
      );
      const result = await controller.getSettings(BIZ_ID);
      expect(result.aiAutoReplyEnabled).toBe(false);
      expect(result.aiAutonomyLevel).toBe('MANUAL');
      expect(result.officeHoursEnabled).toBe(true);
      expect(result.defaultGreeting).toBe('');
      expect(result.defaultSignoff).toBe('');
    });

    it('should return all defaults when business has no settings', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue(makeBiz());
      const result = await controller.getSettings(BIZ_ID);
      expect(result.aiAutoReplyEnabled).toBe(true);
      expect(result.aiAutonomyLevel).toBe('BALANCED');
      expect(result.officeHoursEnabled).toBe(false);
      expect(result.officeHours).toEqual({});
    });
  });

  describe('updateSettings', () => {
    it('should hand the patch to the service and return the merged settings', async () => {
      // The merge itself moved into Postgres — read-modify-write here lost
      // every concurrent write to `profile`, including the suspension marker
      // `suspendBusiness` writes to the same column. See
      // `business-settings-merge.spec.ts`.
      tenantService.updateProfileSettings.mockResolvedValue({
        defaultGreeting: 'Hi',
        officeHoursEnabled: true,
      });

      const result = await controller.updateSettings(BIZ_ID, { officeHoursEnabled: true });

      expect(result).toEqual({ defaultGreeting: 'Hi', officeHoursEnabled: true });
      expect(tenantService.updateProfileSettings).toHaveBeenCalledWith(BIZ_ID, {
        officeHoursEnabled: true,
      });
      expect(prisma.businesses.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.businesses.update).not.toHaveBeenCalled();
    });
  });

  describe('getSubscription', () => {
    it('should map the service subscription into the billing-page shape', async () => {
      // SubscriptionService returns a SubscriptionResponse (plan, pricePaise,
      // isActive, ...); the controller transforms it for the billing page.
      const sub = {
        plan: 'GROWTH',
        name: 'Growth',
        pricePaise: 299900,
        limits: {},
        features: [],
        isActive: true,
      };
      subscriptionService.getSubscription.mockResolvedValue(sub);
      const result = (await controller.getSubscription(BIZ_ID)) as Record<string, unknown>;
      expect(result.plan).toBe('GROWTH');
      expect(result.status).toBe('ACTIVE');
      expect(result.priceMonthlyPaise).toBe(299900);
      expect(result.currentPeriodStart).toBeDefined();
      expect(result.currentPeriodEnd).toBeDefined();
      expect(result.usage).toEqual([]);
    });

    it('should report status INACTIVE when the subscription is not active', async () => {
      subscriptionService.getSubscription.mockResolvedValue({
        plan: 'GROWTH',
        pricePaise: 299900,
        isActive: false,
      });
      const result = (await controller.getSubscription(BIZ_ID)) as Record<string, unknown>;
      expect(result.status).toBe('INACTIVE');
    });

    it('should return fallback defaults when service throws', async () => {
      subscriptionService.getSubscription.mockRejectedValue(new Error('not found'));
      const result = await controller.getSubscription(BIZ_ID) as Record<string, unknown>;
      expect(result.plan).toBe('STARTER');
      expect(result.status).toBe('ACTIVE');
      expect(result.currentPeriodStart).toBeDefined();
      expect(result.currentPeriodEnd).toBeDefined();
    });
  });
});
