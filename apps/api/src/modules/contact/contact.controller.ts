import { Controller, Get, Patch, Post, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import type { Request } from 'express';
import { Req } from '@nestjs/common';
import { TeamMemberRole } from '@gosumo/database';
import { ContactService } from './contact.service';
import { ContactMergeService } from './merge/contact-merge.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { clientIp } from '../../common/utils/client-ip.util';
import {
  ListContactsQueryDto,
  UpdateContactDto,
  TagsDto,
  CreateSegmentDto,
  UpdateSegmentDto,
  SegmentMembersQueryDto,
  FindDuplicatesQueryDto,
  MergeContactsDto,
  PreviewMergeDto,
  ListMergesQueryDto,
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
  constructor(
    private readonly contactService: ContactService,
    private readonly merges: ContactMergeService,
  ) {}

  // ─────────────────────────────────────────────
  // Merge & dedup
  //
  // Declared before /:id, like segments, so "duplicates" and "merges" are never
  // matched as a contact id.
  // ─────────────────────────────────────────────

  @Get('duplicates')
  @ApiOperation({
    summary: 'Suggest probable duplicate contacts',
    description:
      'Suggestions only — nothing is merged at any score. Each pair carries the ' +
      'signals that produced it so a person can judge whether two records really ' +
      'are one customer.',
  })
  @ApiResponse({ status: 200, description: 'Candidate pairs, strongest first' })
  async findDuplicates(
    @TenantId() tenantId: string,
    @Query() query: FindDuplicatesQueryDto,
  ) {
    return this.merges.findDuplicates(tenantId, query);
  }

  @Post('merges/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Show exactly what a merge would do, without doing it',
    description:
      'Computed by the same code that performs the merge, so what is approved is ' +
      'what runs.',
  })
  @ApiResponse({ status: 200, description: 'Per-field decisions and the rows that would move' })
  @ApiResponse({ status: 404, description: 'Either contact is not visible to this business' })
  async previewMerge(@TenantId() tenantId: string, @Body() dto: PreviewMergeDto) {
    return this.merges.previewMerge(
      tenantId,
      dto.survivorId,
      dto.duplicateId,
      dto.strategy,
      dto.fields,
    );
  }

  @Post('merges')
  @Roles(TeamMemberRole.MANAGER)
  @ApiOperation({
    summary: 'Merge one contact into another',
    description:
      'Moves every conversation, order, payment and booking onto the survivor and ' +
      'retires the duplicate. Reversible unless it moved more rows than can be ' +
      'recorded, which the response reports.',
  })
  @ApiResponse({ status: 201, description: 'The merge record and what moved' })
  @ApiResponse({ status: 400, description: 'A contact cannot be merged into itself' })
  @ApiResponse({ status: 403, description: 'Only a MANAGER or OWNER may merge contacts' })
  @ApiResponse({ status: 404, description: 'Either contact is not visible to this business' })
  async mergeContacts(
    @TenantId() tenantId: string,
    @Body() dto: MergeContactsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.merges.merge(tenantId, dto.survivorId, dto.duplicateId, {
      strategy: dto.strategy,
      overrides: dto.fields,
      performedBy: user?.sub,
      actorEmail: user?.email ?? null,
      requestId: (req.headers['x-correlation-id'] as string | undefined) ?? null,
      ipAddress: clientIp(req),
    });
  }

  @Get('merges')
  @ApiOperation({ summary: 'List past contact merges' })
  @ApiResponse({ status: 200, description: 'Merge history, most recent first' })
  async listMerges(@TenantId() tenantId: string, @Query() query: ListMergesQueryDto) {
    return this.merges.listMerges(tenantId, query);
  }

  @Post('merges/:id/revert')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo a merge',
    description:
      'Restores the retired contact and moves back exactly the rows the merge ' +
      'moved. Refuses outright — rather than half-applying — when the merge was ' +
      'recorded as irreversible.',
  })
  @ApiParam({ name: 'id', description: 'Merge UUID' })
  @ApiResponse({ status: 200, description: 'What was restored' })
  @ApiResponse({ status: 400, description: 'Already reverted, or not reversible' })
  @ApiResponse({ status: 404, description: 'No such merge for this business' })
  async revertMerge(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.merges.revert(tenantId, id, {
      revertedBy: user?.sub,
      actorEmail: user?.email ?? null,
    });
  }

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
