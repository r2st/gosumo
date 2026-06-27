import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { OnboardingAssistantService } from './onboarding-assistant.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import {
  UpdateProgressDto,
  OnboardingChatDto,
  OnboardingProgressResponse,
  OnboardingStatusResponse,
  OnboardingChatResponse,
} from './dto';

/**
 * OnboardingController — REST surface for the guided onboarding wizard.
 *
 * Controller path is the bare `onboarding` resource, matching sibling
 * controllers (`tenant`, `ai`, …). The `/v1` version segment in API_DESIGN.md
 * and the dashboard's API base is the documented version prefix layer; routes
 * below are written with it for clarity. All routes are tenant-scoped via
 * @TenantId().
 *   GET  /v1/onboarding/progress  — full wizard progress
 *   PUT  /v1/onboarding/progress  — update a step's status/data
 *   POST /v1/onboarding/complete  — mark onboarding done
 *   GET  /v1/onboarding/status    — should the wizard be shown? (login check)
 *   POST /v1/onboarding/chat      — ask the AI onboarding assistant
 */
@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly assistant: OnboardingAssistantService,
  ) {}

  @Get('progress')
  @ApiOperation({ summary: 'Get the current onboarding wizard progress' })
  @ApiResponse({ status: 200, description: 'Onboarding progress returned' })
  async getProgress(@TenantId() businessId: string): Promise<OnboardingProgressResponse> {
    return this.onboardingService.getProgress(businessId);
  }

  @Put('progress')
  @ApiOperation({ summary: 'Update a single onboarding step (complete/skip + data)' })
  @ApiResponse({ status: 200, description: 'Step updated; progress returned' })
  @ApiResponse({ status: 400, description: 'Unknown step' })
  async updateProgress(
    @TenantId() businessId: string,
    @Body() dto: UpdateProgressDto,
  ): Promise<OnboardingProgressResponse> {
    return this.onboardingService.updateProgress(businessId, dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark onboarding as complete' })
  @ApiResponse({ status: 200, description: 'Onboarding completed' })
  @ApiResponse({ status: 400, description: 'Required steps not finished' })
  async complete(@TenantId() businessId: string): Promise<OnboardingProgressResponse> {
    return this.onboardingService.complete(businessId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Check whether onboarding is still needed (login check)' })
  @ApiResponse({ status: 200, description: 'Onboarding status returned' })
  async getStatus(@TenantId() businessId: string): Promise<OnboardingStatusResponse> {
    return this.onboardingService.getStatus(businessId);
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the AI onboarding assistant a question' })
  @ApiResponse({ status: 200, description: 'Assistant reply returned' })
  async chat(
    @TenantId() businessId: string,
    @Body() dto: OnboardingChatDto,
  ): Promise<OnboardingChatResponse> {
    return this.assistant.chat(businessId, dto);
  }
}
