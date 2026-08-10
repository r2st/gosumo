import { Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CannedResponseService } from './canned-response.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateCannedResponseDto,
  UpdateCannedResponseDto,
  ListCannedResponsesQueryDto,
  RecordUsageDto,
} from './dto';

@ApiTags('canned-responses')
@Controller('canned-responses')
export class CannedResponseController {
  constructor(private readonly cannedResponseService: CannedResponseService) {}

  @Post()
  @ApiOperation({ summary: 'Create a canned response' })
  @ApiResponse({ status: 201, description: 'Canned response created' })
  @ApiResponse({ status: 409, description: 'Shortcut already in use' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateCannedResponseDto,
  ) {
    return this.cannedResponseService.create(tenantId, dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List canned responses with search and filters' })
  async list(@TenantId() tenantId: string, @Query() query: ListCannedResponsesQueryDto) {
    return this.cannedResponseService.list(tenantId, query);
  }

  @Get('shortcut/:shortcut')
  @ApiOperation({ summary: 'Look up a canned response by its shortcut' })
  @ApiParam({ name: 'shortcut' })
  @ApiResponse({ status: 404, description: 'No canned response with this shortcut' })
  async getByShortcut(@TenantId() tenantId: string, @Param('shortcut') shortcut: string) {
    return this.cannedResponseService.getByShortcut(tenantId, shortcut);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a canned response by ID' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.cannedResponseService.get(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a canned response' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateCannedResponseDto,
  ) {
    return this.cannedResponseService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a canned response' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 204, description: 'Canned response deleted' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async delete(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.cannedResponseService.delete(tenantId, id);
  }

  @Post(':id/usage')
  @ApiOperation({ summary: 'Record that a canned response was used (increments usage_count)' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async recordUsage(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RecordUsageDto,
  ) {
    return this.cannedResponseService.recordUsage(tenantId, id, dto.conversationId, userId);
  }
}
