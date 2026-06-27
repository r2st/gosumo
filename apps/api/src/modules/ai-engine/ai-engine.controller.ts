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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AiEngineService } from './ai-engine.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  ProcessMessageDto,
  ClassifyIntentDto,
  ConfidenceScoringInputDto,
  IngestKnowledgeDto,
  SearchKnowledgeQueryDto,
  RegenerateDraftDto,
} from './dto';

/**
 * AiEngineController — REST surface for the AI engine.
 *
 * Routes:
 *   POST   /ai/process                       — run the full pipeline on a message
 *   POST   /ai/intent                        — standalone intent classification
 *   POST   /ai/confidence                    — standalone confidence scoring
 *   POST   /ai/knowledge                     — ingest a document into the KB
 *   GET    /ai/knowledge/search              — semantic search over the KB
 *   DELETE /ai/knowledge/:entryId            — delete a KB entry
 *   GET    /ai/decisions/:decisionId         — fetch a decision
 *   POST   /ai/decisions/:decisionId/regenerate — regenerate a draft
 *
 * Every route is tenant-scoped via @TenantId().
 */
@ApiTags('ai-engine')
@Controller('ai')
export class AiEngineController {
  private readonly logger = new Logger(AiEngineController.name);

  constructor(private readonly aiEngine: AiEngineService) {}

  @Post('process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the AI pipeline on an inbound message' })
  @ApiResponse({ status: 200, description: 'AI decision produced' })
  async process(@TenantId() tenantId: string, @Body() dto: ProcessMessageDto) {
    return this.aiEngine.processMessage(tenantId, dto);
  }

  @Post('intent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Classify the intent of a message' })
  @ApiResponse({ status: 200, description: 'Intent classification result' })
  async classifyIntent(@TenantId() tenantId: string, @Body() dto: ClassifyIntentDto) {
    return this.aiEngine.classifyIntent(tenantId, dto.text);
  }

  @Post('confidence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Score confidence from explicit factors' })
  @ApiResponse({ status: 200, description: 'Confidence score breakdown' })
  scoreConfidence(@TenantId() tenantId: string, @Body() dto: ConfidenceScoringInputDto) {
    return this.aiEngine.scoreConfidence(tenantId, dto);
  }

  @Post('knowledge')
  @ApiOperation({ summary: 'Ingest a document into the knowledge base' })
  @ApiResponse({ status: 201, description: 'Document indexed' })
  async ingestKnowledge(@TenantId() tenantId: string, @Body() dto: IngestKnowledgeDto) {
    return this.aiEngine.ingestKnowledgeBase(tenantId, dto);
  }

  @Get('knowledge/search')
  @ApiOperation({ summary: 'Semantic search over the knowledge base' })
  @ApiResponse({ status: 200, description: 'Matching knowledge entries' })
  async searchKnowledge(@TenantId() tenantId: string, @Query() query: SearchKnowledgeQueryDto) {
    return this.aiEngine.searchKnowledgeBase(tenantId, query.q, query.limit);
  }

  @Delete('knowledge/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a knowledge base entry' })
  @ApiParam({ name: 'entryId', description: 'Knowledge entry UUID' })
  @ApiResponse({ status: 204, description: 'Entry deleted' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  async deleteKnowledge(
    @TenantId() tenantId: string,
    @Param('entryId', UuidValidationPipe) entryId: string,
  ) {
    await this.aiEngine.deleteKnowledgeEntry(tenantId, entryId);
  }

  @Get('decisions/:decisionId')
  @ApiOperation({ summary: 'Get an AI decision by ID' })
  @ApiParam({ name: 'decisionId', description: 'AI decision UUID' })
  @ApiResponse({ status: 200, description: 'AI decision' })
  @ApiResponse({ status: 404, description: 'Decision not found' })
  async getDecision(
    @TenantId() tenantId: string,
    @Param('decisionId', UuidValidationPipe) decisionId: string,
  ) {
    return this.aiEngine.getDraftDecision(tenantId, decisionId);
  }

  @Post('decisions/:decisionId/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate a draft (creates a new decision)' })
  @ApiParam({ name: 'decisionId', description: 'AI decision UUID' })
  @ApiResponse({ status: 200, description: 'New AI decision' })
  @ApiResponse({ status: 404, description: 'Decision not found' })
  async regenerate(
    @TenantId() tenantId: string,
    @Param('decisionId', UuidValidationPipe) decisionId: string,
    @Body() dto: RegenerateDraftDto,
  ) {
    return this.aiEngine.regenerateDraft(tenantId, decisionId, dto);
  }
}
