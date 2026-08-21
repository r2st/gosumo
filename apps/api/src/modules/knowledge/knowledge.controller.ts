import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';

import { KnowledgeService } from './knowledge.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateKnowledgeArticleDto,
  KnowledgeArticleDto,
  KnowledgeSearchHitDto,
  KnowledgeStatsDto,
  ListKnowledgeArticlesQueryDto,
  PaginatedKnowledgeArticlesDto,
  SearchKnowledgeArticlesQueryDto,
  UpdateKnowledgeArticleDto,
} from './dto';

@ApiTags('knowledge')
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Create a knowledge base article' })
  @ApiResponse({ status: 201, description: 'Article created', type: KnowledgeArticleDto })
  @ApiResponse({ status: 409, description: 'Too many articles share this title' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateKnowledgeArticleDto,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.create(tenantId, dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List knowledge base articles' })
  @ApiResponse({ status: 200, description: 'Paginated articles', type: PaginatedKnowledgeArticlesDto })
  async list(
    @TenantId() tenantId: string,
    @Query() query: ListKnowledgeArticlesQueryDto,
  ): Promise<PaginatedKnowledgeArticlesDto> {
    return this.knowledgeService.list(tenantId, query);
  }

  @Get('search')
  @ApiOperation({ summary: 'Ranked full-text search over the knowledge base' })
  @ApiResponse({ status: 200, description: 'Ranked hits', type: [KnowledgeSearchHitDto] })
  async search(
    @TenantId() tenantId: string,
    @Query() query: SearchKnowledgeArticlesQueryDto,
  ): Promise<KnowledgeSearchHitDto[]> {
    return this.knowledgeService.search(tenantId, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Knowledge base coverage counters' })
  @ApiResponse({ status: 200, description: 'Counts by status and category', type: KnowledgeStatsDto })
  async stats(@TenantId() tenantId: string): Promise<KnowledgeStatsDto> {
    return this.knowledgeService.stats(tenantId);
  }

  // Declared before `:id` — otherwise `/knowledge/slug/refund-policy` is
  // matched by the UUID route and answered with a 400 about a malformed UUID.
  @Get('slug/:slug')
  @ApiOperation({ summary: 'Fetch an article by its slug' })
  @ApiParam({ name: 'slug', description: 'Article slug' })
  @ApiResponse({ status: 200, description: 'The article', type: KnowledgeArticleDto })
  @ApiResponse({ status: 404, description: 'No article with this slug' })
  async getBySlug(
    @TenantId() tenantId: string,
    @Param('slug') slug: string,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.getBySlug(tenantId, slug);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch an article by ID' })
  @ApiParam({ name: 'id', description: 'Article UUID' })
  @ApiResponse({ status: 200, description: 'The article', type: KnowledgeArticleDto })
  @ApiResponse({ status: 404, description: 'Article not found' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.get(tenantId, id);
  }

  @Patch(':id')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Update an article' })
  @ApiParam({ name: 'id', description: 'Article UUID' })
  @ApiResponse({ status: 200, description: 'Updated article', type: KnowledgeArticleDto })
  @ApiResponse({ status: 404, description: 'Article not found' })
  async update(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateKnowledgeArticleDto,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.update(tenantId, id, dto, userId);
  }

  @Post(':id/publish')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Publish an article' })
  @ApiParam({ name: 'id', description: 'Article UUID' })
  @ApiResponse({ status: 200, description: 'Published article', type: KnowledgeArticleDto })
  @ApiResponse({ status: 404, description: 'Article not found' })
  @HttpCode(HttpStatus.OK)
  async publish(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.publish(tenantId, id, userId);
  }

  @Post(':id/archive')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Archive an article' })
  @ApiParam({ name: 'id', description: 'Article UUID' })
  @ApiResponse({ status: 200, description: 'Archived article', type: KnowledgeArticleDto })
  @ApiResponse({ status: 404, description: 'Article not found' })
  @HttpCode(HttpStatus.OK)
  async archive(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<KnowledgeArticleDto> {
    return this.knowledgeService.archive(tenantId, id, userId);
  }

  @Delete(':id')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({ summary: 'Soft-delete an article' })
  @ApiParam({ name: 'id', description: 'Article UUID' })
  @ApiResponse({ status: 204, description: 'Article deleted' })
  @ApiResponse({ status: 404, description: 'Article not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<void> {
    await this.knowledgeService.remove(tenantId, id);
  }
}
