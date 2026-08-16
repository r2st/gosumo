import { Controller, Get, Patch, Post, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  ListContactsQueryDto,
  UpdateContactDto,
  TagsDto,
  CreateSegmentDto,
  UpdateSegmentDto,
  SegmentMembersQueryDto,
} from './dto';

/**
 * ContactController — REST endpoints for contact management and segmentation.
 *
 * Routes:
 *   Contacts: /contacts
 *   Segments: /contacts/segments
 */
@ApiTags('contacts')
@Controller('contacts')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // ─────────────────────────────────────────────
  // Segments (declared before /:id so "segments" never matches as an id)
  // ─────────────────────────────────────────────

  @Post('segments')
  @ApiOperation({ summary: 'Create a contact segment' })
  @ApiResponse({ status: 201, description: 'Segment created' })
  @ApiResponse({ status: 409, description: 'Segment name already in use' })
  async createSegment(@TenantId() tenantId: string, @Body() dto: CreateSegmentDto) {
    return this.contactService.createSegment(tenantId, dto);
  }

  @Get('segments')
  @ApiOperation({ summary: 'List contact segments' })
  @ApiResponse({ status: 200, description: 'Paginated segment list for this business' })
  async listSegments(@TenantId() tenantId: string) {
    return this.contactService.listSegments(tenantId);
  }

  @Get('segments/:id')
  @ApiOperation({ summary: 'Get a segment by ID' })
  @ApiResponse({ status: 200, description: 'The requested segment' })
  @ApiParam({ name: 'id', description: 'Segment UUID' })
  @ApiResponse({ status: 404, description: 'Segment not found' })
  async getSegment(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.contactService.getSegment(tenantId, id);
  }

  @Patch('segments/:id')
  @ApiOperation({ summary: 'Update a segment' })
  @ApiResponse({ status: 200, description: 'The updated segment' })
  @ApiParam({ name: 'id', description: 'Segment UUID' })
  @ApiResponse({ status: 404, description: 'Segment not found' })
  @ApiResponse({ status: 409, description: 'Segment name already in use' })
  async updateSegment(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.contactService.updateSegment(tenantId, id, dto);
  }

  @Delete('segments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a segment' })
  @ApiParam({ name: 'id', description: 'Segment UUID' })
  @ApiResponse({ status: 204, description: 'Segment deleted' })
  @ApiResponse({ status: 404, description: 'Segment not found' })
  async deleteSegment(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.contactService.deleteSegment(tenantId, id);
  }

  @Get('segments/:id/members')
  @ApiOperation({ summary: 'List contacts currently matching a segment filter' })
  @ApiResponse({ status: 200, description: 'The requested member' })
  @ApiParam({ name: 'id', description: 'Segment UUID' })
  @ApiResponse({ status: 404, description: 'Segment not found' })
  async getSegmentMembers(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Query() query: SegmentMembersQueryDto,
  ) {
    return this.contactService.getSegmentMembers(tenantId, id, query.page ?? 1, query.limit ?? 20);
  }

  // ─────────────────────────────────────────────
  // Contacts
  // ─────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List contacts with search and filters' })
  @ApiResponse({ status: 200, description: 'Paginated contact list for this business' })
  async listContacts(@TenantId() tenantId: string, @Query() query: ListContactsQueryDto) {
    return this.contactService.listContacts(tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single contact by ID' })
  @ApiResponse({ status: 200, description: 'The requested contact' })
  @ApiParam({ name: 'id', description: 'Contact (client) UUID' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async getContact(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.contactService.getContact(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a contact\'s basic details' })
  @ApiResponse({ status: 200, description: 'The updated contact' })
  @ApiParam({ name: 'id', description: 'Contact (client) UUID' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  @ApiResponse({ status: 409, description: 'Email or phone already in use' })
  async updateContact(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactService.updateContact(tenantId, id, dto);
  }

  @Get(':id/routing')
  @ApiOperation({
    summary: 'Which segment routing rule currently applies to this contact',
    description:
      'The same resolution the AI pipeline performs on every inbound message. Answers ' +
      '"why did this customer get a human?" without reading pipeline logs.',
  })
  @ApiResponse({ status: 200, description: 'The routing decision in force for this contact' })
  @ApiParam({ name: 'id', description: 'Contact (client) UUID' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async getRouting(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.contactService.resolveRouting(tenantId, id);
  }

  @Post(':id/tags')
  @ApiOperation({ summary: 'Add tags to a contact' })
  @ApiResponse({ status: 201, description: 'The created tag' })
  @ApiParam({ name: 'id', description: 'Contact (client) UUID' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async addTags(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: TagsDto,
  ) {
    return this.contactService.addTags(tenantId, id, dto.tags);
  }

  @Delete(':id/tags')
  @ApiOperation({ summary: 'Remove tags from a contact' })
  @ApiResponse({ status: 200, description: 'Deletion result for the tag' })
  @ApiParam({ name: 'id', description: 'Contact (client) UUID' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async removeTags(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: TagsDto,
  ) {
    return this.contactService.removeTags(tenantId, id, dto.tags);
  }
}
