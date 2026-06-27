import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { TenantRepository } from '../tenant.repository';
import { OnboardingStep } from '../tenant.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';

function makeBusiness(completedSteps: string[] = []): Record<string, unknown> {
  return {
    id: BUSINESS_ID,
    plan: 'starter',
    profile: { onboarding: { completedSteps } },
    deleted_at: null,
  };
}

function createMockRepository() {
  return {
    findBusinessById: jest.fn(),
    updateBusiness: jest.fn(),
  };
}

describe('OnboardingService', () => {
  let service: OnboardingService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };
    repository.updateBusiness.mockResolvedValue(makeBusiness());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: TenantRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('getOnboardingStatus', () => {
    it('reports zero progress for a fresh business', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness([]));

      const status = await service.getOnboardingStatus(BUSINESS_ID);

      expect(status.completedSteps).toEqual([]);
      expect(status.nextStep).toBe(OnboardingStep.PROFILE);
      expect(status.percentComplete).toBe(0);
      expect(status.isComplete).toBe(false);
      expect(status.steps).toHaveLength(5);
    });

    it('computes partial progress and the next step', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness([OnboardingStep.PROFILE, OnboardingStep.CHANNEL]),
      );

      const status = await service.getOnboardingStatus(BUSINESS_ID);

      expect(status.completedSteps).toEqual([OnboardingStep.PROFILE, OnboardingStep.CHANNEL]);
      expect(status.nextStep).toBe(OnboardingStep.AI_CONFIG);
      expect(status.percentComplete).toBe(40);
    });

    it('ignores unknown/garbage step values stored in the profile', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness([OnboardingStep.PROFILE, 'NONSENSE']),
      );

      const status = await service.getOnboardingStatus(BUSINESS_ID);
      expect(status.completedSteps).toEqual([OnboardingStep.PROFILE]);
    });
  });

  describe('completeStep', () => {
    it('completes the next step in order and persists it', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness([]));

      const status = await service.completeStep(BUSINESS_ID, OnboardingStep.PROFILE);

      expect(status.completedSteps).toEqual([OnboardingStep.PROFILE]);
      expect(repository.updateBusiness).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          profile: expect.objectContaining({
            onboarding: expect.objectContaining({ completedSteps: [OnboardingStep.PROFILE] }),
          }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.onboarding.step.completed',
        expect.objectContaining({ businessId: BUSINESS_ID, step: OnboardingStep.PROFILE }),
      );
    });

    it('rejects completing a step out of order', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness([]));

      await expect(
        service.completeStep(BUSINESS_ID, OnboardingStep.AI_CONFIG),
      ).rejects.toThrow(BadRequestException);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-completed step', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness([OnboardingStep.PROFILE]));

      const status = await service.completeStep(BUSINESS_ID, OnboardingStep.PROFILE);

      expect(status.completedSteps).toEqual([OnboardingStep.PROFILE]);
      expect(repository.updateBusiness).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('emits business.onboarding.completed on the final step', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness([
          OnboardingStep.PROFILE,
          OnboardingStep.CHANNEL,
          OnboardingStep.AI_CONFIG,
          OnboardingStep.POLICIES,
        ]),
      );

      const status = await service.completeStep(BUSINESS_ID, OnboardingStep.TEAM);

      expect(status.isComplete).toBe(true);
      expect(status.percentComplete).toBe(100);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'business.onboarding.completed',
        expect.objectContaining({ businessId: BUSINESS_ID }),
      );
    });

    it('throws BadRequestException for an unknown step', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness([]));
      await expect(
        service.completeStep(BUSINESS_ID, 'BOGUS' as OnboardingStep),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the business is missing', async () => {
      repository.findBusinessById.mockResolvedValue(null);
      await expect(
        service.completeStep(BUSINESS_ID, OnboardingStep.PROFILE),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
