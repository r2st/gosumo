# GoSumo — Development Guide for AI Agents

> This guide is written for AI coding agents (Claude Code and equivalents) that develop and maintain GoSumo. Every rule here exists to prevent real mistakes made in multi-tenant, event-driven NestJS codebases. Read it before touching any file.

---

## 1. Quick Start

```bash
# Clone and install
git clone <repo-url> gosumo && cd gosumo
pnpm install                          # installs all workspace packages

# Start infrastructure (Postgres, Redis, Qdrant)
docker compose -f docker/docker-compose.yml up -d

# Database setup
pnpm --filter @gosumo/database migrate:dev
pnpm --filter @gosumo/database seed

# Build all packages
pnpm build

# Run API in dev mode (hot reload)
pnpm --filter @gosumo/api dev

# Run dashboard
pnpm --filter @gosumo/dashboard dev

# Run everything in parallel
pnpm dev
```

**Port map:** API `:3000` · Dashboard `:3001` · BullMQ Board `:3002` · Postgres `:5432` · Redis `:6379` · Qdrant `:6333`

---

## 2. Project Conventions

### TypeScript Strict Mode

`tsconfig.base.json` enables `strict: true`. This means:
- No implicit `any`. Use `unknown` and narrow with type guards.
- No non-null assertions (`!`) unless the value is provably non-null with a comment explaining why.
- Return types must be explicit on all public service and controller methods.
- Use `readonly` on DTO properties and interface fields that are never mutated.

### Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `booking.service.ts` |
| Classes | PascalCase | `BookingService` |
| Interfaces | PascalCase, no `I` prefix | `BookingRepository` |
| Functions/methods | camelCase | `findByBusinessId` |
| Variables/params | camelCase | `businessId` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_RETRY_ATTEMPTS` |
| Enums | PascalCase (enum), SCREAMING_SNAKE (values) | `BookingStatus.CONFIRMED` |
| Domain events | dot-separated noun.verb past-tense | `booking.created` |
| BullMQ queues | kebab-case | `ai-processing` |
| Redis keys | `gosumo:{businessId}:{resource}:{id}` | `gosumo:abc:session:xyz` |
| Database tables | snake_case plural | `booking_slots` |
| Prisma models | PascalCase singular | `BookingSlot` |

### Import Ordering

Enforce with ESLint `import/order`. Order is:
1. Node built-ins (`path`, `crypto`)
2. NestJS core (`@nestjs/common`, `@nestjs/core`)
3. Third-party packages (`@prisma/client`, `bullmq`)
4. Internal workspace packages (`@gosumo/shared`, `@gosumo/database`)
5. Relative imports within the module (`./booking.service`, `../common/guards`)

Never use relative paths to cross module boundaries. Always use the `@gosumo/*` alias.

### Error Handling

Use the custom exception hierarchy in `@gosumo/shared`:

```typescript
GoSumoException (base)
├── ValidationException      // 422 — invalid input
├── NotFoundException        // 404 — resource not found
├── ConflictException        // 409 — state conflict
├── UnauthorizedException    // 401 — auth failed
├── ForbiddenException       // 403 — insufficient permissions
├── ExternalServiceException // 502 — third-party API failure
└── BusinessRuleException    // 422 — violated business policy
```

Rules:
- Throw domain exceptions from services, never raw `Error` or NestJS built-ins.
- Never swallow exceptions silently. Either rethrow or emit a failure event.
- BullMQ workers must catch exceptions and call `job.moveToFailed()` with the error.
- Always log the original error before rethrowing a wrapped exception.

### Logging

Use the `LoggerService` from `@gosumo/shared`. All logs must be structured JSON with a correlation ID.

```typescript
this.logger.log({
  event: 'booking.created',
  businessId,           // always include
  bookingId: booking.id,
  correlationId,        // from request context
  durationMs,           // for performance-sensitive paths
});

this.logger.error({
  event: 'booking.create.failed',
  businessId,
  error: err.message,   // message only — never the full object (may contain PII)
  stack: err.stack,
  correlationId,
});
```

**Never log:** customer names, phone numbers, email addresses, message content, payment card details, or anything that could be PII.

---

## 3. Module Development Pattern

Every module lives at `apps/api/src/modules/{module-name}/` and follows this exact structure:

```
booking/
├── booking.module.ts
├── booking.controller.ts
├── booking.service.ts
├── booking.repository.ts
├── dto/
│   ├── create-booking.dto.ts
│   └── update-booking.dto.ts
├── events/
│   └── booking-events.handler.ts
├── booking.controller.spec.ts
├── booking.service.spec.ts
├── booking.repository.spec.ts
└── CLAUDE.md
```

### Controller (thin layer — validate + delegate)

```typescript
@Controller('v1/bookings')
@UseGuards(JwtAuthGuard, TenantGuard)
@UseInterceptors(TenantInterceptor, LoggingInterceptor)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  @Roles(Role.OWNER, Role.MANAGER)
  async create(
    @TenantId() businessId: string,
    @Body() dto: CreateBookingDto,
  ): Promise<BookingResponseDto> {
    return this.bookingService.create(businessId, dto);
  }
}
```

Rules for controllers:
- No business logic. No direct repository calls. No Prisma.
- Every endpoint needs `@UseGuards(JwtAuthGuard, TenantGuard)` — no exceptions.
- Extract `businessId` only via `@TenantId()` decorator, never from the request body.
- Return DTOs, never Prisma model objects directly.

### Service (business logic + transaction boundaries)

```typescript
@Injectable()
export class BookingService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly logger: LoggerService,
  ) {}

  async create(businessId: string, dto: CreateBookingDto): Promise<BookingResponseDto> {
    // 1. Validate business rules
    const conflict = await this.repo.findConflict(businessId, dto.startTime, dto.endTime);
    if (conflict) throw new ConflictException('SLOT_TAKEN', 'That time slot is already booked');

    // 2. Execute within a transaction when multiple writes are needed
    const booking = await this.repo.createWithTransaction(businessId, dto);

    // 3. Emit domain event after successful commit
    this.eventEmitter.emit('booking.created', new BookingCreatedEvent(booking));

    return BookingResponseDto.fromEntity(booking);
  }
}
```

Rules for services:
- `businessId` is the first parameter on every public method.
- Use `this.repo.createWithTransaction()` for any operation touching multiple tables.
- Emit domain events **after** the database transaction commits — never inside it.
- Never call another module's repository directly. Only call other modules' services.

### Repository (Prisma data access)

```typescript
@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(businessId: string, id: string): Promise<Booking | null> {
    return this.prisma.booking.findFirst({
      where: { id, businessId, deletedAt: null },  // businessId ALWAYS in WHERE
    });
  }

  async createWithTransaction(
    businessId: string,
    data: CreateBookingData,
  ): Promise<Booking> {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: { ...data, businessId },
      });
      await tx.bookingSlot.update({
        where: { id: data.slotId, businessId },  // businessId here too
        data: { status: 'RESERVED' },
      });
      return booking;
    });
  }
}
```

Rules for repositories:
- `businessId` appears in every `WHERE` clause, every `CREATE` data payload, every `UPDATE` where clause.
- Use `findFirst` (not `findUnique`) when including `businessId` in lookups so the compound filter is explicit.
- Soft deletes: always filter `deletedAt: null` in read queries.
- Never expose raw Prisma types beyond the repository layer — return typed domain models.

### DTOs (input validation)

```typescript
export class CreateBookingDto {
  @IsUUID()
  @IsNotEmpty()
  readonly clientId: string;

  @IsUUID()
  @IsNotEmpty()
  readonly slotId: string;

  @IsISO8601()
  readonly startTime: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  readonly notes?: string;
}
```

Rules for DTOs:
- All properties `readonly`.
- Every field decorated with at least one `class-validator` decorator.
- Optional fields use `@IsOptional()` before other validators.
- `businessId` is never in a DTO — it comes from the JWT via `@TenantId()`.
- Response DTOs have a static `fromEntity(entity)` factory method.

### Events (domain events)

Define event classes in `@gosumo/shared/src/events/`:

```typescript
// packages/shared/src/events/booking.events.ts
export class BookingCreatedEvent {
  readonly eventName = 'booking.created';
  readonly occurredAt = new Date();
  constructor(
    public readonly businessId: string,
    public readonly bookingId: string,
    public readonly clientId: string,
  ) {}
}
```

Handle in the module that owns the reaction:

```typescript
@Injectable()
export class BookingEventsHandler {
  @OnEvent('booking.created')
  async handleBookingCreated(event: BookingCreatedEvent): Promise<void> {
    // Send confirmation, update calendar, etc.
    // Failures here must be caught and logged — never propagate to the emitter
    try {
      await this.calendarService.createEvent(event);
    } catch (err) {
      this.logger.error({ event: 'calendar.sync.failed', bookingId: event.bookingId, error: err.message });
    }
  }
}
```

### Guards and Interceptors

Guards/interceptors in `apps/api/src/common/`:

| Name | Purpose | Applied |
|---|---|---|
| `JwtAuthGuard` | Validates Bearer token | All authenticated routes |
| `TenantGuard` | Verifies `businessId` claim exists | All tenant routes |
| `RolesGuard` | Checks `@Roles()` decorator | Routes needing RBAC |
| `TenantInterceptor` | Sets `businessId` on request context | All tenant routes |
| `LoggingInterceptor` | Logs request/response with correlation ID | Global |
| `TransformInterceptor` | Wraps responses in `{ data, meta }` envelope | Global |

---

## 4. Testing Requirements

### Coverage Target

Minimum 80% line coverage per module, enforced in CI. Run `pnpm test:coverage` to check.

### Unit Tests

Test one class in isolation. Mock all dependencies.

```typescript
// booking.service.spec.ts
describe('BookingService', () => {
  let service: BookingService;
  let repo: jest.Mocked<BookingRepository>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: BookingRepository, useValue: createMock<BookingRepository>() },
        { provide: EventEmitter2, useValue: createMock<EventEmitter2>() },
      ],
    }).compile();
    service = module.get(BookingService);
    repo = module.get(BookingRepository);
  });

  describe('create', () => {
    it('should create a booking and emit booking.created', async () => { ... });
    it('should throw ConflictException when slot is taken', async () => { ... });
    it('should throw if repository fails', async () => { ... }); // test error paths
  });
});
```

### Integration Tests (testcontainers)

Spin up real Postgres and Redis. Test the repository against a real database.

```typescript
// booking.repository.integration.spec.ts
describe('BookingRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start();
    prisma = new PrismaClient({ datasources: { db: { url: container.getConnectionUri() } } });
    await execSync(`pnpm prisma migrate deploy`, { env: { DATABASE_URL: container.getConnectionUri() } });
  });

  afterAll(() => container.stop());

  it('should enforce businessId isolation', async () => {
    // Create record for business A, verify business B cannot read it
  });
});
```

### E2E Tests

Use `supertest` against the running NestJS app with a test database.

```typescript
// test/booking.e2e-spec.ts
it('POST /v1/bookings returns 401 without auth', () => {
  return request(app.getHttpServer()).post('/v1/bookings').expect(401);
});
```

### Test Naming

```
it('should {expected behavior} when {condition}')
it('should throw {ExceptionType} when {invalid condition}')
it('should not {bad behavior} when {security scenario}')
```

### Mock Patterns

Use `@golevelup/ts-jest` `createMock<T>()` for typed mocks. Never use `jest.fn()` on complex objects — it produces untyped mocks that miss interface changes.

For external HTTP services (Razorpay, Shiprocket, Meta API), create a fake in `test/fakes/` that implements the same interface and returns predictable responses.

### Test Commands

```bash
pnpm test                              # all tests
pnpm test:unit                         # jest, no containers
pnpm test:integration                  # requires Docker
pnpm test:e2e                          # requires Docker + running app
pnpm test:coverage                     # coverage report
pnpm test --filter @gosumo/api         # single package
```

---

## 5. Git Conventions

### Commit Message Format (Conventional Commits)

```
<type>(<scope>): <short description>

[optional body]

[optional footer: BREAKING CHANGE, closes #issue]
```

Types: `feat` · `fix` · `refactor` · `test` · `chore` · `docs` · `perf` · `security`

Scopes match module names: `booking` · `payment` · `ai-engine` · `channel-adapter` · `shared`

Examples:
```
feat(booking): add Google Calendar sync on booking.created event
fix(payment): handle Razorpay webhook duplicate delivery idempotently
test(catalog): add integration tests for variant pricing
security(auth): enforce 2FA on OWNER role password reset
```

### Branch Naming

```
feature/{scope}/{short-description}    # feature/booking/calendar-sync
fix/{scope}/{issue-or-description}     # fix/payment/duplicate-webhook
chore/{description}                    # chore/upgrade-nestjs-10
```

### Atomic Commits

One commit = one logical change. A commit that adds a feature should include the implementation, tests, and any schema migration for that feature — nothing more, nothing less. Do not bundle unrelated fixes.

---

## 6. CLAUDE.md Conventions

### Root CLAUDE.md (`/CLAUDE.md`)

Contains: project purpose, monorepo layout, key commands, links to design docs, and the top-level rules every agent must follow (multi-tenancy, strict mode, event patterns). Kept under 200 lines.

### Module CLAUDE.md (`apps/api/src/modules/{module}/CLAUDE.md`)

Contains only what is specific to that module. Maximum 150 lines.

### Module CLAUDE.md Template

```markdown
# {ModuleName} Module

## Purpose
One paragraph: what this module does and what it does NOT do (boundary).

## Key Files
- `{module}.controller.ts` — REST endpoints
- `{module}.service.ts` — business logic
- `{module}.repository.ts` — Prisma queries
- `events/{module}-events.handler.ts` — domain event handlers

## Commands
```bash
pnpm test --filter @gosumo/api -- --testPathPattern={module}
pnpm prisma studio   # inspect data during development
```

## Public API (what other modules may call)
- `{ModuleService}.findById(businessId, id)` — returns ...
- `{ModuleService}.create(businessId, dto)` — creates ...

## Events Emitted
- `{resource}.created` — after successful create
- `{resource}.updated` — after significant state change

## Events Consumed
- `{other}.{event}` — triggers ...

## External Dependencies
List any third-party APIs, SDKs, or credentials required.

## Gotchas
- Any non-obvious behavior specific to this module
- Known edge cases or race conditions
- Rate limits or quota considerations
```

---

## 7. Database Conventions

### Migration Workflow

```bash
# 1. Edit packages/database/prisma/schema.prisma
# 2. Generate and apply migration
pnpm --filter @gosumo/database migrate:dev --name add_booking_slots_table

# 3. Regenerate Prisma client (happens automatically after migrate:dev)
pnpm --filter @gosumo/database generate

# 4. Run tests to verify schema change doesn't break existing queries
pnpm test:integration
```

### Migration Naming

Use descriptive snake_case names that describe what changed, not when:
- `add_booking_slots_table` not `20260626_migration`
- `add_client_churn_score_column` not `update_clients`
- `create_rls_policy_conversations` not `security_update`

### Schema Change Rules

- Every new table needs: `id UUID DEFAULT gen_random_uuid()`, `businessId UUID NOT NULL`, `createdAt DATETIME`, `updatedAt DATETIME`, `deletedAt DATETIME` (for soft delete).
- Every new table needs an RLS policy. See `DATABASE_DESIGN.md` section 4 for the pattern.
- Add an index on `(businessId, createdAt DESC)` for every new table — this is the default query pattern.
- Never modify an existing migration file. Always create a new one.
- Never use `migrate:reset` outside of local dev — it destroys data.

### Seed Data

Seeds live in `packages/database/prisma/seed.ts`. They are idempotent — running seeds twice must not create duplicates. Use `upsert` not `create`.

```bash
pnpm --filter @gosumo/database seed          # run seeds
pnpm --filter @gosumo/database seed:reset    # wipe and reseed (dev only)
```

---

## 8. API Development Patterns

### Request Validation

NestJS `ValidationPipe` is global and configured with:
- `whitelist: true` — strips unknown properties
- `forbidNonWhitelisted: true` — rejects requests with unknown properties
- `transform: true` — transforms plain objects to DTO class instances

Do not add manual validation in controllers or services when a `class-validator` decorator covers the case.

### Response Serialization

All responses are wrapped by `TransformInterceptor`:
```json
{
  "data": { ... },
  "meta": { "timestamp": "...", "traceId": "..." }
}
```

Paginated responses add:
```json
{
  "data": [ ... ],
  "meta": { "total": 150, "page": 2, "limit": 20, "hasNextPage": true }
}
```

### Pagination

Use cursor-based pagination for large collections (messages, events). Use offset pagination for small admin lists.

```typescript
// Cursor-based (preferred for real-time data)
async findMessages(businessId: string, cursor?: string, limit = 20) {
  return this.prisma.message.findMany({
    where: { businessId, deletedAt: null, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,  // fetch one extra to determine hasNextPage
  });
}
```

### Error Response Format

Throw exceptions from `@gosumo/shared`. The global `HttpExceptionFilter` converts them to:
```json
{
  "statusCode": 404,
  "error": "NOT_FOUND",
  "message": "Booking abc123 not found",
  "traceId": "...",
  "timestamp": "2026-06-26T10:00:00Z"
}
```

### API Versioning

All routes are prefixed `/v1/`. When a breaking change is needed, create a `/v2/` controller alongside the existing one. Never modify a v1 response shape in a breaking way — add new fields only.

---

## 9. Security Checklist

Run through this before every PR. These are the most common failure modes.

### Tenant Isolation
- [ ] Every Prisma query includes `businessId` in the `WHERE` clause
- [ ] Every `CREATE` includes `businessId` in the data payload
- [ ] Every BullMQ job payload includes `businessId` and the processor validates it
- [ ] Redis keys follow the `gosumo:{businessId}:...` pattern
- [ ] Qdrant queries filter by `businessId` in the payload filter

### Input Validation
- [ ] Every controller parameter is a typed DTO with `class-validator` decorators
- [ ] `@IsUUID()` on all ID parameters (prevents injection)
- [ ] File uploads validated for MIME type and size before processing
- [ ] Customer message content is treated as untrusted data — never passed to system prompts unescaped

### Authentication & Authorization
- [ ] Every controller has `@UseGuards(JwtAuthGuard, TenantGuard)`
- [ ] Endpoints needing RBAC have `@Roles(...)` with `RolesGuard`
- [ ] Webhook endpoints skip `JwtAuthGuard` but use `WebhookSignatureGuard` instead
- [ ] No endpoint is public without explicit justification in a comment

### PII in Logs
- [ ] No `customer.name`, `customer.phone`, `customer.email` in any log statement
- [ ] No `message.content` (customer message text) in any log statement
- [ ] Error logs include `error.message` only, not the full error object

### Webhook Security
- [ ] All inbound webhooks go through `WebhookSignatureGuard`
- [ ] HMAC-SHA256 verification uses `crypto.timingSafeEqual` (never `===`)
- [ ] Webhook payloads are stored raw before processing (for replay/debugging)

---

## 10. Common Gotchas

### Multi-Tenancy: Missing businessId Filter

**Wrong:**
```typescript
return this.prisma.booking.findUnique({ where: { id } });
```
**Right:**
```typescript
return this.prisma.booking.findFirst({ where: { id, businessId } });
```
PostgreSQL RLS is a defense-in-depth backstop, not a substitute for application-level filtering. Always filter explicitly.

### Async: Unhandled BullMQ Job Failures

**Wrong:**
```typescript
async process(job: Job) {
  await this.aiEngine.classify(job.data);  // if this throws, job silently fails
}
```
**Right:**
```typescript
async process(job: Job) {
  try {
    await this.aiEngine.classify(job.data);
  } catch (err) {
    this.logger.error({ event: 'ai.classify.failed', jobId: job.id, error: err.message });
    throw err;  // rethrow so BullMQ marks job failed and retries
  }
}
```

### Types: Using `any`

**Wrong:**
```typescript
const payload: any = JSON.parse(webhookBody);
```
**Right:**
```typescript
const payload = JSON.parse(webhookBody) as unknown;
if (!isRazorpayWebhookPayload(payload)) throw new ValidationException('INVALID_PAYLOAD');
```
Write a type guard. `any` disables type checking for everything downstream.

### Tests: Not Testing Error Paths

Every service method must have a test for the failure case. If you write `it('should create a booking')`, you must also write `it('should throw ConflictException when slot is taken')` and `it('should throw if repository throws')`. CI enforces coverage minimums — missing error path tests will cause coverage to drop below 80%.

### Events: Emitting Before Transaction Commits

**Wrong:**
```typescript
return this.prisma.$transaction(async (tx) => {
  const booking = await tx.booking.create({ data });
  this.eventEmitter.emit('booking.created', booking);  // transaction not committed yet!
  return booking;
});
```
**Right:**
```typescript
const booking = await this.repo.createWithTransaction(businessId, data);
this.eventEmitter.emit('booking.created', new BookingCreatedEvent(booking));  // after commit
```

### Cross-Module Access: Bypassing Service Layer

**Wrong:**
```typescript
// In BookingService — importing another module's repository
import { CatalogRepository } from '../catalog/catalog.repository';
```
**Right:**
```typescript
// Inject the other module's service (its public API)
import { CatalogService } from '../catalog/catalog.service';
```
Repositories are private to their module. Only services are shared.

### Circular Dependencies

If you get a NestJS `Nest cannot create the [X] instance` error, you likely created a circular dependency. Fix by:
1. Extracting shared logic into `@gosumo/shared`
2. Using the Event Bus instead of direct service injection for the cross-module call
3. Using `forwardRef()` as a last resort (prefer the event bus approach)
