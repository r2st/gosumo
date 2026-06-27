import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ClientIntelligenceService } from './client-intelligence.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  FindOrCreateClientDto,
  UpdateClientProfileDto,
  ListClientsQueryDto,
  MergeClientsDto,
  SentimentTrendQueryDto,
  TimelineQueryDto,
} from './dto';

/**
 * ClientIntelligenceController — REST endpoints for client profile management
 * and intelligence queries.
 *
 * All routes are protected by the global JwtAuthGuard. The @TenantId()
 * decorator extracts the businessId from the JWT-populated request context.
 *
 * Routes:
 *   POST   /clients         — find or create a client
 *   GET    /clients          — list clients with filters
 *   GET    /clients/:id      — get client profile
 *   PATCH  /clients/:id      — update client profile
 *   POST   /clients/merge    — merge two client records
 *   GET    /clients/:id/sentiment — sentiment trend
 *   GET    /clients/:id/churn     — churn score
 *   GET    /clients/:id/ltv       — LTV estimate
 *   GET    /clients/:id/summary   — AI-injectable summary
 */
@ApiTags('clients')
@Controller('clients')
export class ClientIntelligenceController {
  private readonly logger = new Logger(ClientIntelligenceController.name);

  constructor(private readonly clientIntelligenceService: ClientIntelligenceService) {}

  // ───────────────────────────────────────────────────────────────────
  // Merge — must be BEFORE :id routes to avoid "merge" as UUID
  // ───────────────────────────────────────────────────────────────────

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Merge two client records' })
  @ApiResponse({ status: 200, description: 'Clients merged successfully' })
  @ApiResponse({ status: 400, description: 'Cannot merge a client with itself' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async mergeClients(
    @TenantId() tenantId: string,
    @Body() dto: MergeClientsDto,
  ) {
    return this.clientIntelligenceService.mergeClients(
      tenantId,
      dto.primaryId,
      dto.secondaryId,
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Client CRUD
  // ───────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Find or create a client by external ID and channel' })
  @ApiResponse({ status: 201, description: 'Client profile' })
  async findOrCreateClient(
    @TenantId() tenantId: string,
    @Body() dto: FindOrCreateClientDto,
  ) {
    return this.clientIntelligenceService.findOrCreateClient(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List clients with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of clients' })
  async listClients(
    @TenantId() tenantId: string,
    @Query() query: ListClientsQueryDto,
  ) {
    return this.clientIntelligenceService.listClients(tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a client profile by ID' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Client profile' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getClientProfile(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.clientIntelligenceService.getClientProfile(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a client profile' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Updated client profile' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async updateClientProfile(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateClientProfileDto,
  ) {
    return this.clientIntelligenceService.updateClientProfile(tenantId, id, dto);
  }

  // ───────────────────────────────────────────────────────────────────
  // Intelligence endpoints
  // ───────────────────────────────────────────────────────────────────

  @Get(':id/sentiment')
  @ApiOperation({ summary: 'Get sentiment trend for a client' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Sentiment trend data' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getSentimentTrend(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Query() query: SentimentTrendQueryDto,
  ) {
    return this.clientIntelligenceService.getClientSentimentTrend(
      tenantId,
      id,
      query.days ?? 30,
    );
  }

  @Get(':id/churn')
  @ApiOperation({ summary: 'Get churn risk score for a client' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Churn score and risk level' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getChurnScore(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.clientIntelligenceService.getChurnScore(tenantId, id);
  }

  @Get(':id/ltv')
  @ApiOperation({ summary: 'Get lifetime value estimate for a client' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'LTV estimate' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getLTVEstimate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.clientIntelligenceService.getLTVEstimate(tenantId, id);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Get compact AI-injectable summary for a client' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'AI summary (max 300 chars)' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getClientSummary(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.clientIntelligenceService.getClientSummaryForAI(tenantId, id);
  }

  @Get(':id/segment')
  @ApiOperation({ summary: 'Get the behavioural segment for a client' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Client segment classification' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getClientSegment(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.clientIntelligenceService.getClientSegment(tenantId, id);
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Get a chronological timeline of all client interactions' })
  @ApiParam({ name: 'id', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Chronological timeline (newest first)' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async getClientTimeline(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Query() query: TimelineQueryDto,
  ) {
    return this.clientIntelligenceService.getClientTimeline(
      tenantId,
      id,
      query.limit ?? 50,
    );
  }
}
