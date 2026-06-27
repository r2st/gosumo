import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingStepId, OnboardingStepStatus } from './onboarding.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';

function makeBusiness(onboarding_progress: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: BUSINESS_ID, deleted_at: null, onboarding_progress };
}

function createMockRepository() {
  return {
    findBusinessById: jest.fn(),
    getProgress: jest.fn(),
    saveProgress: jest.fn().mockResolvedValue(undefined),
  };
}

describe('OnboardingService', () => {
  let service: OnboardingService;
  let repository: ReturnType<typeof createMockRepository>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    repository = createMockRepository();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: OnboardingRepository, useValue: repository },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('getProgress', () => {
    it('reports a fresh, untouched wizard', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const progress = await service.getProgress(BUSINESS_ID);

      expect(progress.steps).toHaveLength(6);
      expect(progress.steps.every((s) => s.status === OnboardingStepStatus.PENDING)).toBe(true);
      expect(progress.currentStep).toBe(OnboardingStepId.WELCOME);
      expect(progress.completedCount).toBe(0);
      expect(progress.percentComplete).toBe(0);
      expect(progress.isComplete).toBe(false);
      // Step metadata travels with each step for the UI.
      const welcomeStep = progress.steps.find((s) => s.step === OnboardingStepId.WELCOME);
      expect(welcomeStep?.definition.title).toContain('Welcome');
    });

    it('throws NotFoundException for a missing business', async () => {
      repository.findBusinessById.mockResolvedValue(null);
      await expect(service.getProgress(BUSINESS_ID)).rejects.toThrow(NotFoundException);
    });

    it('ignores garbage step values stored in the column', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          steps: {
            [OnboardingStepId.WELCOME]: { status: 'COMPLETED-ish', data: { x: 1 } },
            BOGUS_STEP: { status: 'completed' },
          },
        }),
      );

      const progress = await service.getProgress(BUSINESS_ID);
      const welcome = progress.steps.find((s) => s.step === OnboardingStepId.WELCOME);
      // Invalid status falls back to PENDING but preserved data still surfaces.
      expect(welcome?.status).toBe(OnboardingStepStatus.PENDING);
      expect(welcome?.data).toEqual({ x: 1 });
      // Unknown steps are dropped — still exactly the 6 canonical steps.
      expect(progress.steps).toHaveLength(6);
    });
  });

  describe('updateProgress', () => {
    it('completes a step by default and persists merged data', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const progress = await service.updateProgress(BUSINESS_ID, {
        step: OnboardingStepId.WELCOME,
        data: { timezone: 'Asia/Kolkata' },
      });

      const welcome = progress.steps.find((s) => s.step === OnboardingStepId.WELCOME);
      expect(welcome?.status).toBe(OnboardingStepStatus.COMPLETED);
      expect(welcome?.data).toEqual({ timezone: 'Asia/Kolkata' });
      expect(progress.completedCount).toBe(1);

      expect(repository.saveProgress).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          startedAt: expect.any(String),
          steps: expect.objectContaining({
            [OnboardingStepId.WELCOME]: expect.objectContaining({
              status: OnboardingStepStatus.COMPLETED,
              data: { timezone: 'Asia/Kolkata' },
            }),
          }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'onboarding.wizard.step.updated',
        expect.objectContaining({ businessId: BUSINESS_ID, step: OnboardingStepId.WELCOME }),
      );
    });

    it('records an explicit skip', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const progress = await service.updateProgress(BUSINESS_ID, {
        step: OnboardingStepId.CATALOG,
        status: OnboardingStepStatus.SKIPPED,
      });

      const catalog = progress.steps.find((s) => s.step === OnboardingStepId.CATALOG);
      expect(catalog?.status).toBe(OnboardingStepStatus.SKIPPED);
      expect(progress.skippedCount).toBe(1);
      expect(progress.completedCount).toBe(0);
    });

    it('merges new data into existing step data', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          steps: {
            [OnboardingStepId.AI_CONFIG]: {
              status: OnboardingStepStatus.COMPLETED,
              data: { tone: 'friendly' },
            },
          },
        }),
      );

      const progress = await service.updateProgress(BUSINESS_ID, {
        step: OnboardingStepId.AI_CONFIG,
        data: { language: 'en' },
      });

      const ai = progress.steps.find((s) => s.step === OnboardingStepId.AI_CONFIG);
      expect(ai?.data).toEqual({ tone: 'friendly', language: 'en' });
    });

    it('rejects an unknown step', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());
      await expect(
        service.updateProgress(BUSINESS_ID, { step: 'NONSENSE' as OnboardingStepId }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.saveProgress).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('blocks completion when a required step is unfinished', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      await expect(service.complete(BUSINESS_ID)).rejects.toThrow(BadRequestException);
      expect(repository.saveProgress).not.toHaveBeenCalled();
    });

    it('completes when required steps are done and skips the rest', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({
          steps: {
            [OnboardingStepId.WELCOME]: { status: OnboardingStepStatus.COMPLETED, data: {} },
            [OnboardingStepId.CHANNELS]: { status: OnboardingStepStatus.COMPLETED, data: {} },
          },
        }),
      );

      const progress = await service.complete(BUSINESS_ID);

      expect(progress.isComplete).toBe(true);
      expect(progress.completedAt).toEqual(expect.any(String));
      // Untouched optional steps are recorded as skipped on finish.
      const catalog = progress.steps.find((s) => s.step === OnboardingStepId.CATALOG);
      expect(catalog?.status).toBe(OnboardingStepStatus.SKIPPED);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'onboarding.wizard.completed',
        expect.objectContaining({ businessId: BUSINESS_ID }),
      );
    });
  });

  describe('getStatus', () => {
    it('says onboarding is needed for a fresh business', async () => {
      repository.findBusinessById.mockResolvedValue(makeBusiness());

      const status = await service.getStatus(BUSINESS_ID);

      expect(status.needed).toBe(true);
      expect(status.isComplete).toBe(false);
      expect(status.currentStep).toBe(OnboardingStepId.WELCOME);
      expect(status.completedAt).toBeNull();
    });

    it('says onboarding is not needed once completed', async () => {
      repository.findBusinessById.mockResolvedValue(
        makeBusiness({ completedAt: '2026-06-27T00:00:00.000Z', steps: {} }),
      );

      const status = await service.getStatus(BUSINESS_ID);

      expect(status.needed).toBe(false);
      expect(status.isComplete).toBe(true);
      expect(status.completedAt).toBe('2026-06-27T00:00:00.000Z');
    });
  });
});
