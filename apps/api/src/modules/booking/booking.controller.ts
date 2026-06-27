import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { BookingService } from './booking.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateBookingDto,
  CreateRecurringBookingDto,
  RescheduleBookingDto,
  CancelBookingDto,
  GetSlotsQueryDto,
  SetAvailabilityDto,
  BlockSlotDto,
  ConnectGoogleCalendarDto,
  ListBookingsQueryDto,
} from './dto';

/**
 * BookingController — REST endpoints for appointment scheduling.
 *
 * All routes sit behind the global JwtAuthGuard; `@TenantId()` provides the
 * authenticated business id.
 */
@ApiTags('bookings')
@Controller('bookings')
export class BookingController {
  private readonly logger = new Logger(BookingController.name);

  constructor(private readonly bookingService: BookingService) {}

  // ─── Availability & slots ───

  @Put('availability')
  @ApiOperation({ summary: 'Create or replace the weekly availability template' })
  @ApiResponse({ status: 200, description: 'Availability saved' })
  async setAvailability(
    @TenantId() tenantId: string,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.bookingService.setAvailability(tenantId, dto);
  }

  @Get('slots')
  @ApiOperation({ summary: 'Get available appointment slots over a date range' })
  @ApiResponse({ status: 200, description: 'List of bookable slots' })
  async getSlots(
    @TenantId() tenantId: string,
    @Query() query: GetSlotsQueryDto,
  ) {
    return this.bookingService.getAvailableSlots(tenantId, query);
  }

  @Post('blocks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Block a time range from being booked' })
  @ApiResponse({ status: 201, description: 'Time blocked' })
  async blockSlot(@TenantId() tenantId: string, @Body() dto: BlockSlotDto) {
    return this.bookingService.blockSlot(tenantId, dto);
  }

  @Delete('blocks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a blocked time range' })
  @ApiParam({ name: 'id', description: 'Blocked slot UUID' })
  async unblockSlot(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.bookingService.unblockSlot(tenantId, id);
  }

  // ─── Google Calendar ───

  @Get('calendar/google/auth-url')
  @ApiOperation({ summary: 'Get the Google Calendar OAuth consent URL' })
  @ApiResponse({ status: 200, description: 'Consent URL' })
  async getGoogleAuthUrl(
    @TenantId() tenantId: string,
    @Query('staffId') staffId?: string,
    @Query('redirectUri') redirectUri?: string,
  ) {
    return this.bookingService.getGoogleAuthUrl(tenantId, staffId, redirectUri);
  }

  @Post('calendar/google/connect')
  @ApiOperation({ summary: 'Complete Google Calendar OAuth and store the connection' })
  @ApiResponse({ status: 201, description: 'Calendar connected' })
  @HttpCode(HttpStatus.CREATED)
  async connectGoogle(
    @TenantId() tenantId: string,
    @Body() dto: ConnectGoogleCalendarDto,
  ) {
    return this.bookingService.connectGoogleCalendar(tenantId, dto);
  }

  @Post('calendar/google/sync')
  @ApiOperation({ summary: 'Push future bookings to Google Calendar' })
  @ApiResponse({ status: 200, description: 'Sync summary' })
  @HttpCode(HttpStatus.OK)
  async syncGoogle(
    @TenantId() tenantId: string,
    @Query('staffId') staffId?: string,
  ) {
    return this.bookingService.syncGoogleCalendar(tenantId, staffId);
  }

  @Get('calendar/google')
  @ApiOperation({ summary: 'Get the current Google Calendar connection status' })
  @ApiResponse({ status: 200, description: 'Connection status (or null)' })
  async getGoogleConnection(
    @TenantId() tenantId: string,
    @Query('staffId') staffId?: string,
  ) {
    return this.bookingService.getCalendarConnection(tenantId, staffId);
  }

  @Delete('calendar/google')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect Google Calendar' })
  async disconnectGoogle(
    @TenantId() tenantId: string,
    @Query('staffId') staffId?: string,
  ) {
    await this.bookingService.disconnectGoogleCalendar(tenantId, staffId);
  }

  // ─── Bookings ───

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new booking' })
  @ApiResponse({ status: 201, description: 'Booking created' })
  @ApiResponse({ status: 409, description: 'Slot already booked' })
  async createBooking(
    @TenantId() tenantId: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingService.createBooking(tenantId, dto);
  }

  @Post('recurring')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a recurring booking series' })
  @ApiResponse({ status: 201, description: 'Series created with per-occurrence results' })
  async createRecurring(
    @TenantId() tenantId: string,
    @Body() dto: CreateRecurringBookingDto,
  ) {
    return this.bookingService.createRecurringBooking(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List bookings with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated bookings' })
  async listBookings(
    @TenantId() tenantId: string,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.bookingService.listBookings(tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single booking' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  @ApiResponse({ status: 404, description: 'Booking not found' })
  async getBooking(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.bookingService.getBooking(tenantId, id);
  }

  @Patch(':id/confirm')
  @ApiOperation({ summary: 'Confirm a pending booking' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  async confirmBooking(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.bookingService.confirmBooking(tenantId, id);
  }

  @Patch(':id/reschedule')
  @ApiOperation({ summary: 'Reschedule a booking to a new time' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  @ApiResponse({ status: 400, description: 'Slot unavailable or invalid state' })
  async rescheduleBooking(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RescheduleBookingDto,
  ) {
    return this.bookingService.rescheduleBooking(tenantId, id, dto);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a booking (optionally the whole series)' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  async cancelBooking(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookingService.cancelBooking(tenantId, id, dto);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark a booking as completed' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  async completeBooking(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.bookingService.completeBooking(tenantId, id);
  }

  @Patch(':id/no-show')
  @ApiOperation({ summary: 'Mark a booking as a no-show' })
  @ApiParam({ name: 'id', description: 'Booking UUID' })
  async markNoShow(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.bookingService.markNoShow(tenantId, id);
  }
}
