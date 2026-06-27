# Module: booking

Manages appointment scheduling for service-based businesses (salons, clinics, tutors, consultants). Owns service definitions, staff availability, time slot computation, booking lifecycle, Google Calendar sync, and reminder delivery.

## Purpose

Enable the AI to answer "when are you available?" and complete bookings end-to-end without human intervention. Sync with Google Calendar bidirectionally so staff never get double-booked.

## Public API (IBookingService)

```typescript
// Service configuration
createBookingService / updateBookingService / listBookingServices

// Availability
getAvailableSlots(businessId, dto: GetSlotsQueryDto): Promise<SlotDto[]>
blockSlot / unblockSlot

// Appointments
createBooking(businessId, dto: CreateBookingDto): Promise<BookingDto>
getBooking / listBookings
cancelBooking(businessId, bookingId, dto): Promise<BookingDto>
rescheduleBooking(businessId, bookingId, dto): Promise<BookingDto>
confirmBooking(businessId, bookingId): Promise<BookingDto>

// Google Calendar
connectGoogleCalendar / syncGoogleCalendar / disconnectGoogleCalendar

// Reminders
scheduleReminders(businessId, bookingId): Promise<void>
```

## Events

**Emits:**
- `booking.created` — `{ businessId, bookingId, clientId, serviceId, startTime, staffMemberId }`
- `booking.cancelled` — `{ businessId, bookingId, reason, cancelledBy }`
- `booking.rescheduled` — `{ businessId, bookingId, oldStartTime, newStartTime }`
- `booking.confirmed` — `{ businessId, bookingId }`
- `booking.reminder` — `{ businessId, bookingId, minutesBefore }` (self-consumed)

**Listens to:**
- `payment.success` — auto-confirm the booking when associated payment arrives
- `booking.reminder` (self) — trigger reminder message via `channel-adapter`

## Tables Owned

- `bookings` — appointment records, status, Google Calendar sync IDs, reminder tracking
- (Staff schedules and slot blocks are stored in `bookings` metadata or as separate records — implement as needed)

## Dependencies

- `@gosumo/shared` — `BookingStatus`, timezone utils
- `@gosumo/catalog` — validates `catalogItemId` for booking services
- `@gosumo/tenant` — business timezone and operating hours
- `@gosumo/channel-adapter` — sending reminder messages to customers
- `googleapis` — Google Calendar API (OAuth2)
- BullMQ — delayed reminder jobs (24h and 1h before appointment)

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/booking
```

## Key Gotchas

- **Slots are computed dynamically** from schedule + blocks + existing bookings — there are no pre-generated slot records. `getAvailableSlots()` computes in real-time
- **Slot duration = service `durationMinutes` + `bufferMinutes`** — the buffer prevents back-to-back bookings
- **Auto-cancel:** bookings in PENDING status (awaiting payment) are auto-cancelled via BullMQ job after 24h if no payment received
- **Auto-confirm:** when `payment.success` arrives for a booking's `payment_id`, transition PENDING → CONFIRMED immediately
- **Google Calendar sync** runs on: booking created, booking cancelled, daily background job. If OAuth token is expired, refresh silently; if refresh fails, emit a HITL alert task
- **Double-booking protection:** check slot availability inside a database transaction — do not check then insert in separate operations
- All booking times are stored as UTC (`Timestamptz`) in the database; display conversion to IST happens in the frontend
- Reminder messages are sent via `channel-adapter.sendTemplate()` — the template must be pre-approved on the channel
