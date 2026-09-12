import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { SubscriptionService } from './services/subscription.service';
import { UsageService } from './services/usage.service';
import { OnboardingService } from './services/onboarding.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { UpdateAIConfigDto } from './dto/ai-config.dto';
import { ConnectChannelDto } from './dto/connect-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateBusinessPoliciesDto } from './dto/business-policies.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { SuspendBusinessDto } from './dto/suspend-business.dto';
import { OnboardingStep } from './tenant.constants';
import { Roles } from '../auth/decorators/roles.decorator';
import { TeamMemberRole } from '@gosumo/database';

/**
 * TenantController — REST endpoints for tenant/business management.
 *
 * All routes are protected (no @Public decorator). The @TenantId() decorator
 * extracts the businessId from the JWT-populated request context, ensuring
 * tenants can only access their own data.
 *
 * Routes:
 *   GET    /tenant/profile             — get business profile
 *   PATCH  /tenant/profile             — update business profile
 *   GET    /tenant/ai-config           — get AI configuration
 *   PATCH  /tenant/ai-config           — update AI configuration
 *   GET    /tenant/channels            — list connected channels
 *   POST   /tenant/channels            — connect a new channel
 *   PATCH  /tenant/channels/:id        — update a channel status (activate/pause)
 *   DELETE /tenant/channels/:id        — disconnect a channel
 *   GET    /tenant/members             — list team members
 *   POST   /tenant/members/invite      — invite a new team member
 *   DELETE /tenant/members/:userId     — remove a team member
 *   GET    /tenant/policies            — get business policies
 *   PATCH  /tenant/policies            — update business policies
 */
@ApiTags('tenant')
@Controller('tenant')
export class TenantController {
  private readonly logger = new Logger(TenantController.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly subscriptionService: SubscriptionService,
    private readonly usageService: UsageService,
    private readonly onboardingService: OnboardingService,
  ) {}

  // ─────────────────────────────────────────────
  // Business Lifecycle
  // ─────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a new business (tenant)' })
  @ApiResponse({ status: 201, description: 'Business created' })
  @ApiResponse({ status: 400, description: 'Validation error or duplicate email' })
  async createBusiness(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBusinessDto,
  ) {
    return this.tenantService.createBusiness(dto, user.sub, user.email);
  }

  @Post('suspend')
  @Roles(TeamMemberRole.OWNER)
  @ApiOperation({ summary: 'Suspend the current business' })
  @ApiResponse({ status: 201, description: 'Business suspended' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async suspend(
    @TenantId() businessId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SuspendBusinessDto,
  ) {
    return this.tenantService.suspendBusiness(businessId, dto, {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  @Post('activate')
  @Roles(TeamMemberRole.OWNER)
  @ApiOperation({ summary: 'Activate the current business' })
  @ApiResponse({ status: 201, description: 'Business activated' })
  @ApiResponse({ status: 400, description: 'No connected channel' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async activate(@TenantId() businessId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantService.activateBusiness(businessId, {
      id: user.sub,
      email: user.email ?? null,
    });
  }

  // ─────────────────────────────────────────────
  // Business Profile
  // ─────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get business profile' })
  @ApiResponse({ status: 200, description: 'Business profile returned' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async getProfile(@TenantId() businessId: string) {
    return this.tenantService.getBusinessById(businessId);
  }

  @Patch('profile')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update business profile' })
  @ApiResponse({ status: 200, description: 'Business profile updated' })
  @ApiResponse({ status: 400, description: 'Validation error or duplicate email' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async updateProfile(
    @TenantId() businessId: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.tenantService.updateBusiness(businessId, dto);
  }

  // ─────────────────────────────────────────────
  // AI Configuration
  // ─────────────────────────────────────────────

  @Get('ai-config')
  @ApiOperation({ summary: 'Get AI configuration' })
  @ApiResponse({ status: 200, description: 'AI config returned' })
  async getAIConfig(@TenantId() businessId: string) {
    return this.tenantService.getAIConfig(businessId);
  }

  @Patch('ai-config')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update AI configuration' })
  @ApiResponse({ status: 200, description: 'AI config updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async updateAIConfig(
    @TenantId() businessId: string,
    @Body() dto: UpdateAIConfigDto,
  ) {
    return this.tenantService.updateAIConfig(businessId, dto);
  }

  // ─────────────────────────────────────────────
  // Channel Connections
  // ─────────────────────────────────────────────

  @Get('channels')
  @ApiOperation({ summary: 'List connected channels' })
  @ApiResponse({ status: 200, description: 'List of channel accounts' })
  async getChannels(@TenantId() businessId: string) {
    return this.tenantService.getChannelConnections(businessId);
  }

  @Post('channels')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Connect a new channel' })
  @ApiResponse({ status: 201, description: 'Channel connected' })
  @ApiResponse({ status: 400, description: 'Plan limit exceeded or validation error' })
  async connectChannel(
    @TenantId() businessId: string,
    @Body() dto: ConnectChannelDto,
  ) {
    return this.tenantService.connectChannel(businessId, dto);
  }

  @Patch('channels/:id')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update a channel status (activate/pause)' })
  @ApiParam({ name: 'id', description: 'Channel account UUID' })
  @ApiResponse({ status: 200, description: 'Channel status updated' })
  @ApiResponse({ status: 404, description: 'Channel account not found' })
  async updateChannel(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) channelAccountId: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.tenantService.setChannelStatus(businessId, channelAccountId, dto.isActive);
  }

  @Delete('channels/:id')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a channel' })
  @ApiParam({ name: 'id', description: 'Channel account UUID' })
  @ApiResponse({ status: 204, description: 'Channel disconnected' })
  @ApiResponse({ status: 404, description: 'Channel account not found' })
  async disconnectChannel(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) channelAccountId: string,
  ) {
    await this.tenantService.disconnectChannel(businessId, channelAccountId);
  }

  // ─────────────────────────────────────────────
  // Team Members
  // ─────────────────────────────────────────────

  @Get('members')
  @ApiOperation({ summary: 'List team members' })
  @ApiResponse({ status: 200, description: 'List of team members' })
  async getMembers(@TenantId() businessId: string) {
    return this.tenantService.getMembers(businessId);
  }

  @Post('members/invite')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Invite a new team member' })
  @ApiResponse({ status: 201, description: 'Member invited' })
  @ApiResponse({ status: 400, description: 'Plan limit exceeded or duplicate email' })
  @ApiResponse({
    status: 403,
    description: 'Caller is not OWNER/MANAGER, or the invited role outranks the caller',
  })
  async inviteMember(
    @TenantId() businessId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteMemberDto,
  ) {
    return this.tenantService.inviteMember(businessId, dto, user.sub);
  }

  @Delete('members/:userId')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a team member' })
  @ApiParam({ name: 'userId', description: 'Team member UUID' })
  @ApiResponse({ status: 204, description: 'Member removed' })
  @ApiResponse({
    status: 403,
    description: 'Cannot remove business owner, caller is not OWNER/MANAGER, or the target outranks the caller',
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async removeMember(
    @TenantId() businessId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', UuidValidationPipe) userId: string,
  ) {
    await this.tenantService.removeMember(businessId, userId, user.sub);
  }

  // ─────────────────────────────────────────────
  // Business Policies
  // ─────────────────────────────────────────────

  @Get('policies')
  @ApiOperation({ summary: 'Get business policies' })
  @ApiResponse({ status: 200, description: 'Business policies returned' })
  async getPolicies(@TenantId() businessId: string) {
    return this.tenantService.getPolicies(businessId);
  }

  @Patch('policies')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update business policies' })
  @ApiResponse({ status: 200, description: 'Policies updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async updatePolicies(
    @TenantId() businessId: string,
    @Body() dto: UpdateBusinessPoliciesDto,
  ) {
    return this.tenantService.updatePolicies(businessId, dto);
  }

  // ─────────────────────────────────────────────
  // Subscription
  // ─────────────────────────────────────────────

  @Get('subscription/plans')
  @ApiOperation({ summary: 'List available subscription plans' })
  @ApiResponse({ status: 200, description: 'Plan catalog returned' })
  getPlanCatalog() {
    return this.subscriptionService.getPlanCatalog();
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get the current subscription' })
  @ApiResponse({ status: 200, description: 'Subscription returned' })
  async getSubscription(@TenantId() businessId: string) {
    return this.subscriptionService.getSubscription(businessId);
  }

  @Post('subscription/change')
  @Roles(TeamMemberRole.OWNER)
  @ApiOperation({ summary: 'Change subscription tier (upgrade/downgrade)' })
  @ApiResponse({ status: 201, description: 'The subscription after the tier change' })
  @ApiResponse({ status: 200, description: 'Plan changed' })
  @ApiResponse({ status: 400, description: 'Downgrade blocked by current usage' })
  async changePlan(
    @TenantId() businessId: string,
    @Body() dto: ChangePlanDto,
  ) {
    return this.subscriptionService.changePlan(businessId, dto);
  }

  // ─────────────────────────────────────────────
  // Usage & Quota
  // ─────────────────────────────────────────────

  @Get('usage')
  @ApiOperation({ summary: 'Get usage snapshot vs plan quotas' })
  @ApiResponse({ status: 200, description: 'Usage snapshot returned' })
  async getUsage(@TenantId() businessId: string) {
    return this.usageService.getUsage(businessId);
  }

  // ─────────────────────────────────────────────
  // Onboarding
  // ─────────────────────────────────────────────

  @Get('onboarding')
  @ApiOperation({ summary: 'Get onboarding status' })
  @ApiResponse({ status: 200, description: 'Onboarding status returned' })
  async getOnboarding(@TenantId() businessId: string) {
    return this.onboardingService.getOnboardingStatus(businessId);
  }

  @Post('onboarding/:step/complete')
  @ApiOperation({ summary: 'Mark an onboarding step complete' })
  @ApiResponse({ status: 201, description: 'Result of the complete action' })
  @ApiParam({ name: 'step', enum: OnboardingStep, description: 'Step' })
  @ApiResponse({ status: 200, description: 'Step completed' })
  @ApiResponse({ status: 400, description: 'Invalid or out-of-order step' })
  async completeOnboardingStep(
    @TenantId() businessId: string,
    @Param('step') step: string,
  ) {
    return this.onboardingService.completeStep(
      businessId,
      step.toUpperCase() as OnboardingStep,
    );
  }
}
