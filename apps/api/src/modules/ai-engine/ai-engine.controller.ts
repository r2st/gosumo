import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AiEngineService } from './ai-engine.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import {
  ProcessMessageDto,
  ClassifyIntentDto,
  ListDecisionsQueryDto,
  AIDecisionDto,
  IntentClassificationDto,
  RegenerateDraftDto,
  IngestKnowledgeDto,
  IngestResultDto,
  SearchKnowledgeQueryDto,
  KnowledgeEntryDto,
  UpdateConfidenceThresholdsDto,
} from './dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { TeamMemberRole } from '@gosumo/database';

/**
 * AiEngineController -- REST surface for the AI engine.
 *
 * Routes:
 *   POST  /ai/process                  -- manually trigger message processing
 *   GET   /ai/decisions/:id            -- get a single AI decision
 *   GET   /ai/decisions                -- list decisions for a conversation
 *   POST  /ai/classify                 -- standalone intent classification
 *   POST  /ai/decisions/:id/regenerate -- re-run LLM with feedback
 *
 * Every route is tenant-scoped via @TenantId().
 */
@ApiTags('AI Engine')
@Controller('ai')
export class AiEngineController {
  private readonly logger = new Logger(AiEngineController.name);

  constructor(private readonly aiEngine: AiEngineService) {}

  // ───────────────────────────────────────────────────────────────────
  // Message processing
  // ───────────────────────────────────────────────────────────────────

  @Post('process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger AI message processing (admin/testing)' })
  @ApiResponse({ status: 200, description: 'AI decision produced', type: AIDecisionDto })
  async process(
    @TenantId() tenantId: string,
    @Body() dto: ProcessMessageDto,
  ): Promise<AIDecisionDto> {
    return this.aiEngine.processMessage(tenantId, dto);
  }

  // ───────────────────────────────────────────────────────────────────
  // Decisions
  // ───────────────────────────────────────────────────────────────────

  @Get('decisions')
  @ApiOperation({ summary: 'List AI decisions for a conversation' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of AI decisions',
  })
  async listDecisions(
    @TenantId() tenantId: string,
    @Query() query: ListDecisionsQueryDto,
  ): Promise<{ data: AIDecisionDto[]; total: number; page: number; limit: number }> {
    return this.aiEngine.listDecisions(tenantId, query);
  }

  @Get('decisions/:id')
  @ApiOperation({ summary: 'Get a single AI decision by ID' })
  @ApiParam({ name: 'id', description: 'AI decision UUID' })
  @ApiResponse({ status: 200, description: 'AI decision', type: AIDecisionDto })
  @ApiResponse({ status: 404, description: 'Decision not found' })
  async getDecision(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AIDecisionDto> {
    return this.aiEngine.getDraftDecision(tenantId, id);
  }

  @Post('decisions/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-run LLM with optional reviewer feedback' })
  @ApiParam({ name: 'id', description: 'AI decision UUID' })
  @ApiResponse({ status: 200, description: 'Regenerated AI decision', type: AIDecisionDto })
  @ApiResponse({ status: 404, description: 'Decision not found' })
  async regenerate(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegenerateDraftDto,
  ): Promise<AIDecisionDto> {
    return this.aiEngine.regenerateDraft(tenantId, id, dto.feedback);
  }

  // ───────────────────────────────────────────────────────────────────
  // Intent classification
  // ───────────────────────────────────────────────────────────────────

  @Post('classify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Standalone intent classification' })
  @ApiResponse({ status: 200, description: 'Intent classification result', type: IntentClassificationDto })
  async classifyIntent(
    @TenantId() tenantId: string,
    @Body() dto: ClassifyIntentDto,
  ): Promise<IntentClassificationDto> {
    return this.aiEngine.classifyIntent(tenantId, dto.text);
  }


  // ─── Confidence thresholds (settings page) ───

  @Get('confidence/thresholds')
  @ApiOperation({ summary: 'Get AI confidence thresholds' })
  @ApiResponse({ status: 200, description: 'The confidence thresholds routing auto-execute, HITL and escalation' })
  async getThresholds(@TenantId() tenantId: string) {
    return this.aiEngine.getConfidenceThresholds(tenantId);
  }

  @Patch('confidence/thresholds')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update AI confidence thresholds' })
  @ApiResponse({ status: 200, description: 'The updated confidence thresholds' })
  async updateThresholds(
    @TenantId() tenantId: string,
    @Body() dto: UpdateConfidenceThresholdsDto,
  ) {
    return this.aiEngine.updateConfidenceThresholds(tenantId, dto);
  }

  // ───────────────────────────────────────────────────────────────────
  // Knowledge base
  // ───────────────────────────────────────────────────────────────────

  @Post('knowledge')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Ingest a document into the knowledge base' })
  @ApiResponse({ status: 201, description: 'Document indexed', type: IngestResultDto })
  async ingestKnowledge(
    @TenantId() tenantId: string,
    @Body() dto: IngestKnowledgeDto,
  ): Promise<IngestResultDto> {
    return this.aiEngine.ingestKnowledgeBase(tenantId, dto);
  }

  @Get('knowledge/search')
  @ApiOperation({ summary: 'Semantic search over the knowledge base' })
  @ApiResponse({ status: 200, description: 'Matching knowledge entries', type: [KnowledgeEntryDto] })
  async searchKnowledge(
    @TenantId() tenantId: string,
    @Query() query: SearchKnowledgeQueryDto,
  ): Promise<KnowledgeEntryDto[]> {
    return this.aiEngine.searchKnowledgeBase(tenantId, query.q, query.limit);
  }

  @Delete('knowledge/:entryId')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a knowledge base entry' })
  @ApiParam({ name: 'entryId', description: 'Knowledge entry UUID' })
  @ApiResponse({ status: 204, description: 'Entry deleted' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  async deleteKnowledge(
    @TenantId() tenantId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<void> {
    await this.aiEngine.deleteKnowledgeEntry(tenantId, entryId);
  }
}
