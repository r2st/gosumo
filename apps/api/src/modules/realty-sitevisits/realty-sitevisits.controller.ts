import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { RealtyVisitsService } from './realty-sitevisits.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  BookVisitDto,
  RescheduleVisitDto,
  CancelVisitDto,
  CompleteVisitDto,
  ListVisitsQueryDto,
  CalendarQueryDto,
} from './dto';

/**
 * RealtyVisitsController — REST surface for site-visit scheduling.
 * JWT-guarded globally; @TenantId() supplies the scoped businessId.
 */
@ApiTags('realty-sitevisits')
@Controller('realty/site-visits')
export class RealtyVisitsController {
  constructor(private readonly visitsService: RealtyVisitsService) {}

  @Post()
  @ApiOperation({ summary: 'Book a site visit (books calendar + reminders, advances lead)' })
  @ApiResponse({ status: 201, description: 'Visit booked' })
  async book(@TenantId() tenantId: string, @Body() dto: BookVisitDto) {
    return this.visitsService.bookVisit(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List site visits with filters and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated visits' })
  async list(@TenantId() tenantId: string, @Query() query: ListVisitsQueryDto) {
    return this.visitsService.listVisits(tenantId, query);
  }

  @Get('calendar')
  @ApiOperation({ summary: 'Visits within a date range for the calendar view' })
  @ApiResponse({ status: 200, description: 'Visits in range' })
  async calendar(@TenantId() tenantId: string, @Query() query: CalendarQueryDto) {
    return this.visitsService.getCalendar(tenantId, query.from, query.to);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single site visit' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  @ApiResponse({ status: 200, description: 'Visit details' })
  @ApiResponse({ status: 404, description: 'Visit not found' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.visitsService.getVisit(tenantId, id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm buyer attendance' })
  @ApiResponse({ status: 200, description: 'Result of the confirm action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  async confirm(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.visitsService.confirmVisit(tenantId, id);
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reschedule a site visit to a new time' })
  @ApiResponse({ status: 200, description: 'Result of the reschedule action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  async reschedule(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RescheduleVisitDto,
  ) {
    return this.visitsService.rescheduleVisit(tenantId, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a site visit' })
  @ApiResponse({ status: 200, description: 'Result of the cancel action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  async cancel(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CancelVisitDto,
  ) {
    return this.visitsService.cancelVisit(tenantId, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a visit completed with feedback + outcome' })
  @ApiResponse({ status: 200, description: 'Result of the complete action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  async complete(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CompleteVisitDto,
  ) {
    return this.visitsService.completeVisit(tenantId, id, dto);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a visit as a no-show' })
  @ApiResponse({ status: 200, description: 'Result of the no show action' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  async noShow(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.visitsService.markNoShow(tenantId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a site visit' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Visit UUID' })
  @ApiResponse({ status: 204, description: 'Visit deleted' })
  async remove(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.visitsService.deleteVisit(tenantId, id);
  }
}
