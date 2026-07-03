# Module: realty-sitevisits (GoSumo Realty — Phase 3)

Property **site-visit scheduling**. Books visits on top of the `booking` module's Google Calendar OAuth, runs the realty reminder cadence (T-24h, T-2h), drives the lead pipeline, and captures post-visit feedback + outcome.

## Public API (RealtyVisitsService)

```typescript
bookVisit(businessId, dto): Promise<SiteVisitDto>       // create + calendar + reminders + lead→VISIT_BOOKED
getVisit / listVisits / getCalendar(from, to)
confirmVisit(businessId, id)                            // → CONFIRMED
rescheduleVisit(businessId, id, dto)                    // new time, re-syncs calendar + reminders
cancelVisit(businessId, id, dto)                        // removes calendar event + reminders
completeVisit(businessId, id, dto)                      // feedback + outcome, lead→VISITED
markNoShow(businessId, id)                              // → NO_SHOW
fireReminder(businessId, id, minutesBefore)             // called by the Bull processor
```

## Booking-module integration (Google Calendar)

Reuses `BookingService.pushRealtyVisitToCalendar` / `removeRealtyVisitFromCalendar` — the booking module owns the OAuth connection + silent token refresh, so this module never touches calendar credentials. Calendar sync is **best-effort**: a missing/expired connection leaves the visit intact (unsynced) and raises a HITL task via the booking module. The gcal staff calendar is chosen by `staffId` (falls back to `assignedAgentId`), remembered in `metadata.calendarStaffId`.

## Reminders (dedicated `realty-visits` Bull queue)

Offsets `[1440, 120]` minutes (T-24h, T-2h). Jobs use jobId `visit-reminder:{visitId}:{minutes}`; `scheduleReminders` removes stale jobs first so a reschedule never double-fires. Offsets already in the past are skipped. The processor calls `fireReminder`, which emits `realty.visit.reminder` (self-consumed by the notification path) and records `reminder_state` + `reminders_sent`.

## Lead pipeline coupling

Injects `RealtyLeadsService` (synchronous cross-module write): booking → `VISIT_BOOKED`, completion → `VISITED`. Wrapped so a lead error never aborts the visit operation.

## Events

**Emits:** `realty.visit.booked`, `realty.visit.confirmed`, `realty.visit.rescheduled`, `realty.visit.cancelled`, `realty.visit.completed`, `realty.visit.no_show`, `realty.visit.reminder`.

## Tables owned

- `realty_site_visits` — `lead_id / project_id / unit_id` (loose module-boundary UUID refs, DB-level FKs), `scheduled_at`, `status`, calendar linkage, `reminder_state`, `feedback`, `outcome`.

## Key gotchas

- **Times stored UTC** (`Timestamptz`); display conversion to IST happens in the frontend. `scheduledAt` must be in the future.
- **Terminal statuses** (COMPLETED / NO_SHOW / CANCELLED) reject further transitions.
- **Soft delete only** (`deleted_at`); soft-deleting also clears pending reminders.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-sitevisits
```
