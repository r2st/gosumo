import { Test, TestingModule } from '@nestjs/testing';
import { BusinessController } from './business.controller';
import { TenantService } from './tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ_ID = '11111111-1111-1111-1111-111111111111';

function makeBiz(overrides: Record<string, any> = {}) {
  return { id: BIZ_ID, name: 'Test Biz', email: 'test@example.com', profile: {}, ai_settings: {}, ...overrides };
}

describe('BusinessController', () => {
  let controller: BusinessController;
  let tenantService: { getBusinessById: jest.Mock; updateBusiness: jest.Mock };
  let subscriptionService: { getSubscription: jest.Mock };
  let prisma: { businesses: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    tenantService = { getBusinessById: jest.fn(), updateBusiness: jest.fn() };
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
      const result = await controller.updateMe(BIZ_ID, { name: 'Updated' } as any);
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
    it('should merge new settings into existing profile.settings', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue(
        makeBiz({ profile: { settings: { defaultGreeting: 'Hi' }, companyBio: 'We rock' } }),
      );
      prisma.businesses.update.mockResolvedValue({});
      const result = await controller.updateSettings(BIZ_ID, { officeHoursEnabled: true });
      expect(result).toEqual({ defaultGreeting: 'Hi', officeHoursEnabled: true });
      expect(prisma.businesses.update).toHaveBeenCalledWith({
        where: { id: BIZ_ID },
        data: { profile: expect.objectContaining({ companyBio: 'We rock', settings: { defaultGreeting: 'Hi', officeHoursEnabled: true } }) },
      });
    });
  });

  describe('getSubscription', () => {
    it('should return subscription from service', async () => {
      const sub = { plan: 'GROWTH', status: 'ACTIVE' };
      subscriptionService.getSubscription.mockResolvedValue(sub);
      const result = await controller.getSubscription(BIZ_ID);
      expect(result).toEqual(sub);
    });

    it('should return fallback defaults when service throws', async () => {
      subscriptionService.getSubscription.mockRejectedValue(new Error('not found'));
      const result = await controller.getSubscription(BIZ_ID) as any;
      expect(result.plan).toBe('STARTER');
      expect(result.status).toBe('ACTIVE');
      expect(result.currentPeriodStart).toBeDefined();
      expect(result.currentPeriodEnd).toBeDefined();
    });
  });
});
