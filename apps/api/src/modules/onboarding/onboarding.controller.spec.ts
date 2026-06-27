import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingAssistantService } from './onboarding-assistant.service';
import { OnboardingStepId, OnboardingStepStatus } from './onboarding.constants';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';

describe('OnboardingController', () => {
  let controller: OnboardingController;
  let onboardingService: {
    getProgress: jest.Mock;
    updateProgress: jest.Mock;
    complete: jest.Mock;
    getStatus: jest.Mock;
  };
  let assistant: { chat: jest.Mock };

  beforeEach(async () => {
    onboardingService = {
      getProgress: jest.fn(),
      updateProgress: jest.fn(),
      complete: jest.fn(),
      getStatus: jest.fn(),
    };
    assistant = { chat: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [
        { provide: OnboardingService, useValue: onboardingService },
        { provide: OnboardingAssistantService, useValue: assistant },
      ],
    }).compile();

    controller = module.get(OnboardingController);
  });

  it('delegates progress reads to the service with the tenant id', async () => {
    onboardingService.getProgress.mockResolvedValue({ isComplete: false });
    await controller.getProgress(BUSINESS_ID);
    expect(onboardingService.getProgress).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it('delegates step updates', async () => {
    const dto = { step: OnboardingStepId.WELCOME, status: OnboardingStepStatus.COMPLETED };
    onboardingService.updateProgress.mockResolvedValue({});
    await controller.updateProgress(BUSINESS_ID, dto);
    expect(onboardingService.updateProgress).toHaveBeenCalledWith(BUSINESS_ID, dto);
  });

  it('delegates completion', async () => {
    onboardingService.complete.mockResolvedValue({ isComplete: true });
    await controller.complete(BUSINESS_ID);
    expect(onboardingService.complete).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it('delegates status checks', async () => {
    onboardingService.getStatus.mockResolvedValue({ needed: true });
    const res = await controller.getStatus(BUSINESS_ID);
    expect(res).toEqual({ needed: true });
  });

  it('delegates chat to the assistant', async () => {
    const dto = { message: 'hi', step: OnboardingStepId.CHANNELS };
    assistant.chat.mockResolvedValue({ reply: 'hello', suggestedQuestions: [], source: 'ai' });
    await controller.chat(BUSINESS_ID, dto);
    expect(assistant.chat).toHaveBeenCalledWith(BUSINESS_ID, dto);
  });
});
