import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsArray,
  IsBoolean,
  IsUrl,
  ValidateNested,
  Min,
  Max,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BookingStatus,
  BookingLocationType,
  BookingActor,
  RecurrenceFrequency,
} from '@gosumo/shared';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

// ─────────────────────────────────────────────
// Availability DTOs
// ─────────────────────────────────────────────

/** A single weekly availability window, in local minutes from midnight. */
export class WeeklyHourDto {
  @ApiProperty({ description: 'Day of week, 0=Sunday … 6=Saturday', minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ description: 'Window start, minutes from local midnight (e.g. 540 = 09:00)', minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  startMinute!: number;

  @ApiProperty({ description: 'Window end, minutes from local midnight (e.g. 1080 = 18:00)', minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinute!: number;
}

/** Create or replace the weekly availability template for a business/staff. */
export class SetAvailabilityDto {
  @ApiPropertyOptional({ description: 'Staff member this schedule applies to. Omit for the business-wide default.' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'IANA timezone the windows are expressed in', default: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiProperty({ description: 'Weekly recurring availability windows', type: [WeeklyHourDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyHourDto)
  weeklyHours!: WeeklyHourDto[];

  @ApiPropertyOptional({ description: 'Slot generation granularity in minutes', default: 30 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  slotIntervalMinutes?: number;

  @ApiPropertyOptional({ description: 'Buffer after each booking in minutes', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(480)
  bufferMinutes?: number;

  @ApiPropertyOptional({ description: 'Minimum lead time before a slot is bookable', default: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(43200)
  minNoticeMinutes?: number;

  @ApiPropertyOptional({ description: 'How far ahead bookings are allowed, in days', default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  maxAdvanceDays?: number;

  @ApiPropertyOptional({ description: 'Concurrent bookings allowed per slot', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacityPerSlot?: number;
}

/** Query for available slots over a date range. */
export class GetSlotsQueryDto {
  @ApiProperty({ description: 'Range start (inclusive), ISO-8601' })
  @IsCalendarDateString()
  from!: string;

  @ApiProperty({ description: 'Range end (exclusive), ISO-8601' })
  @IsCalendarDateString()
  to!: string;

  @ApiProperty({ description: 'Required slot duration in minutes', minimum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes!: number;

  @ApiPropertyOptional({ description: 'Restrict to a specific staff member' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Catalog SERVICE item the slot is for (duration may be derived from it)' })
  @IsOptional()
  @IsUUID()
  catalogItemId?: string;
}

/** Block a time range so no bookings can be made in it. */
export class BlockSlotDto {
  @ApiProperty({ description: 'Block start, ISO-8601' })
  @IsCalendarDateString()
  startAt!: string;

  @ApiProperty({ description: 'Block end, ISO-8601' })
  @IsCalendarDateString()
  endAt!: string;

  @ApiPropertyOptional({ description: 'Restrict the block to one staff member' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Human-readable reason (holiday, leave, lunch)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ─────────────────────────────────────────────
// Booking command DTOs
// ─────────────────────────────────────────────

export class CreateBookingDto {
  @ApiProperty({ description: 'UUID of the client booking the appointment' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Appointment start instant, ISO-8601 (UTC)' })
  @IsCalendarDateString()
  startAt!: string;

  @ApiProperty({ description: 'Appointment duration in minutes', minimum: 5 })
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes!: number;

  @ApiPropertyOptional({ description: 'IANA timezone the booking was made in', default: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Catalog SERVICE item being booked' })
  @IsOptional()
  @IsUUID()
  catalogItemId?: string;

  @ApiPropertyOptional({ description: 'Staff member assigned to the booking' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ enum: BookingLocationType, description: 'Where the booking takes place' })
  @IsOptional()
  @IsEnum(BookingLocationType)
  locationType?: BookingLocationType;

  @ApiPropertyOptional({ description: 'Physical address for IN_PERSON / HOME_VISIT' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  locationAddress?: string;

  @ApiPropertyOptional({ description: 'Meeting URL for ONLINE bookings' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  meetingUrl?: string;

  @ApiPropertyOptional({ description: 'Price in paise (integer)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePaise?: number;

  @ApiPropertyOptional({ description: 'Required deposit in paise (integer)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositPaise?: number;

  @ApiPropertyOptional({ description: 'UUID of the conversation that produced this booking' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Free-text notes for the booking' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'If true, the booking starts CONFIRMED. If false (default), it starts PENDING and is auto-cancelled after 24h without a payment.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  autoConfirm?: boolean;
}

/** Rule for a recurring appointment series. */
export class RecurrenceRuleDto {
  @ApiProperty({ enum: RecurrenceFrequency })
  @IsEnum(RecurrenceFrequency)
  frequency!: RecurrenceFrequency;

  @ApiPropertyOptional({ description: 'Step size (every N units)', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  interval?: number;

  @ApiPropertyOptional({ description: 'Number of occurrences to generate' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  count?: number;

  @ApiPropertyOptional({ description: 'Stop generating after this instant, ISO-8601' })
  @IsOptional()
  @IsCalendarDateString()
  until?: string;

  @ApiPropertyOptional({ description: 'For WEEKLY: weekdays to repeat on (0=Sun..6=Sat)', type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  byWeekday?: number[];
}

/** Create a recurring series; each occurrence becomes its own booking. */
export class CreateRecurringBookingDto extends CreateBookingDto {
  @ApiProperty({ description: 'Recurrence rule', type: RecurrenceRuleDto })
  @ValidateNested()
  @Type(() => RecurrenceRuleDto)
  recurrence!: RecurrenceRuleDto;
}

export class RescheduleBookingDto {
  @ApiProperty({ description: 'New start instant, ISO-8601 (UTC)' })
  @IsCalendarDateString()
  newStartAt!: string;

  @ApiPropertyOptional({ description: 'New duration in minutes (defaults to the existing duration)' })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: 'New staff member, if reassigning' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ enum: BookingActor, description: 'Who is rescheduling', default: BookingActor.BUSINESS })
  @IsOptional()
  @IsEnum(BookingActor)
  rescheduledBy?: BookingActor;
}

export class CancelBookingDto {
  @ApiProperty({ description: 'Reason for cancellation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ enum: BookingActor, description: 'Who is cancelling', default: BookingActor.BUSINESS })
  @IsOptional()
  @IsEnum(BookingActor)
  cancelledBy?: BookingActor;

  @ApiPropertyOptional({ description: 'For a recurring booking, cancel the whole series rather than this occurrence', default: false })
  @IsOptional()
  @IsBoolean()
  cancelSeries?: boolean;
}

// ─────────────────────────────────────────────
// Google Calendar DTOs
// ─────────────────────────────────────────────

export class ConnectGoogleCalendarDto {
  @ApiProperty({ description: 'OAuth authorization code returned to the redirect URI' })
  @IsString()
  @IsNotEmpty()
  authCode!: string;

  @ApiPropertyOptional({ description: 'Redirect URI used in the consent request (defaults to configured value)' })
  @IsOptional()
  @IsString()
  redirectUri?: string;

  @ApiPropertyOptional({ description: 'Target Google calendar ID', default: 'primary' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  calendarId?: string;

  @ApiPropertyOptional({ description: 'Connect for a specific staff member rather than the business' })
  @IsOptional()
  @IsUUID()
  staffId?: string;
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

export class ListBookingsQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ description: 'Filter by client UUID' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Filter by staff UUID' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Bookings starting on or after this instant, ISO-8601' })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Bookings starting on or before this instant, ISO-8601' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Include related data' })
  @IsOptional()
  @IsString()
  include?: string;
}

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────

export interface BookingDto {
  id: string;
  businessId: string;
  clientId: string;
  catalogItemId: string | null;
  staffId: string | null;
  recurrenceId: string | null;
  status: BookingStatus;
  startAt: string;
  endAt: string;
  timezone: string;
  durationMinutes: number;
  locationType: string | null;
  locationAddress: string | null;
  meetingUrl: string | null;
  /** Price in paise */
  pricePaise: number | null;
  /** Deposit in paise */
  depositPaise: number | null;
  paymentId: string | null;
  gcalEventId: string | null;
  gcalCalendarId: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancelledBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlotDto {
  startAt: string;
  endAt: string;
  /** Remaining capacity for this slot (>= 1 means bookable). */
  available: number;
  staffId: string | null;
}

export interface AvailabilityDto {
  id: string;
  businessId: string;
  staffId: string | null;
  timezone: string;
  weeklyHours: WeeklyHourDto[];
  slotIntervalMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  capacityPerSlot: number;
  isActive: boolean;
}

export interface BlockedSlotDto {
  id: string;
  businessId: string;
  staffId: string | null;
  startAt: string;
  endAt: string;
  reason: string | null;
}

export interface CalendarConnectionDto {
  id: string;
  businessId: string;
  staffId: string | null;
  provider: string;
  googleCalendarId: string | null;
  googleAccountEmail: string | null;
  syncEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  connected: boolean;
}

export interface RecurringBookingResultDto {
  recurrenceId: string;
  occurrences: BookingDto[];
  /** Occurrences that could not be created because the slot was taken. */
  skipped: Array<{ startAt: string; reason: string }>;
}

/** A staff member offered as a booking assignee. */
export interface StaffMemberDto {
  id: string;
  /** Display name; falls back to the email local-part for invited members. */
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
}
