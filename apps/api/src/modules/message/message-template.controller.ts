import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { MessageTemplateService } from './message-template.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateTemplateDto,
  CreateQuickReplyDto,
  RenderTemplateDto,
  ListTemplatesQueryDto,
} from './dto';

/**
 * MessageTemplateController — manage reusable message templates and quick
 * replies. Mounted under a distinct path to avoid colliding with the
 * `messages/:id` routes.
 */
@ApiTags('message-templates')
@Controller('message-templates')
export class MessageTemplateController {
  constructor(private readonly templates: MessageTemplateService) {}

  @Get()
  @ApiOperation({ summary: 'List templates (filterable by channel/category)' })
  @ApiResponse({ status: 200, description: 'Templates' })
  async list(
    @TenantId() businessId: string,
    @Query() query: ListTemplatesQueryDto,
  ) {
    return this.templates.listTemplates(businessId, {
      channel: query.channel,
      category: query.category,
    });
  }

  @Get('quick-replies')
  @ApiOperation({ summary: 'List quick-reply snippets' })
  @ApiResponse({ status: 200, description: 'Quick replies' })
  async listQuickReplies(@TenantId() businessId: string) {
    return this.templates.listQuickReplies(businessId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a reusable template' })
  @ApiResponse({ status: 201, description: 'Template created' })
  async create(
    @TenantId() businessId: string,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templates.createTemplate(businessId, {
      channel: dto.channel,
      name: dto.name,
      content: dto.content,
      variables: dto.variables,
      category: dto.category,
      language: dto.language,
      externalName: dto.externalName,
    });
  }

  @Post('quick-replies')
  @ApiOperation({ summary: 'Create a quick-reply snippet' })
  @ApiResponse({ status: 201, description: 'Quick reply created' })
  async createQuickReply(
    @TenantId() businessId: string,
    @Body() dto: CreateQuickReplyDto,
  ) {
    return this.templates.createQuickReply(
      businessId,
      dto.name,
      dto.body,
      dto.channel,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template by ID' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Template' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async get(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.templates.getTemplate(businessId, id);
  }

  @Post(':id/render')
  @HttpCode(200)
  @ApiOperation({ summary: 'Render a template with variables' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Rendered template' })
  async render(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RenderTemplateDto,
  ) {
    return this.templates.renderTemplate(businessId, id, dto.variables ?? {});
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a template' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Template deleted' })
  async remove(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.templates.deleteTemplate(businessId, id);
    return { deleted: true };
  }
}
