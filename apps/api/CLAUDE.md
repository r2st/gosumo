# GoSumo API App

NestJS 10 backend serving all business logic, webhooks, REST API, and WebSocket connections for GoSumo. Runs on port 3000.

## Commands

```bash
# From repo root
pnpm --filter @gosumo/api dev          # Watch mode dev server
pnpm --filter @gosumo/api build        # Production build
pnpm --filter @gosumo/api test         # All tests
pnpm --filter @gosumo/api test:unit    # Unit tests (apps/api/test/unit)
pnpm --filter @gosumo/api test:e2e     # E2E tests (apps/api/test/e2e, runs serially)
pnpm --filter @gosumo/api lint         # ESLint

# From apps/api/
nest start --debug --watch             # Debug mode with breakpoints
```

## Structure

```
src/
  modules/          # Feature modules (one directory per module)
  common/
    guards/         # JwtAuthGuard (global), RolesGuard
    interceptors/   # LoggingInterceptor, TenantInterceptor
    filters/        # HttpExceptionFilter (global)
    decorators/     # @CurrentUser(), @TenantId(), @Public(), @Roles()
    pipes/          # UuidValidationPipe
  config/           # app.config.ts — typed config via @nestjs/config
  main.ts           # Bootstrap: global pipes, filters, Swagger
```

## Global Setup (main.ts)

- `ValidationPipe` — applied globally; `whitelist: true`, `transform: true`
- `HttpExceptionFilter` — standardized error responses
- `LoggingInterceptor` — request/response logging with correlation IDs
- Swagger UI — served at `/v1/docs`, **development only**. In production it is not mounted at all (it would publish every route and DTO); set `ENABLE_SWAGGER=true` to override.
- CORS — origins come from `CORS_ORIGIN` (comma-separated for a list). When it is unset the origin falls back to `*` and credentials are switched **off**, since `Access-Control-Allow-Origin: *` with credentials is the one combination the CORS spec forbids. The rule lives in `common/utils/cors.util.ts`; the web-chat socket applies the same rule to its own `WEBCHAT_ALLOWED_ORIGINS`. **Every value is trimmed and empties are dropped, including the single-value case** — `CORS_ORIGIN=` (set but empty, what a half-filled `.env` leaves) is a string, so `?? '*'` never fires and `''` reached `enableCors`; the `cors` package treats any falsy origin as the wildcard while `allowCredentials` saw a non-wildcard string, producing exactly the forbidden pairing and skipping the production warning, which only recognises a literal `*`. An untrimmed single origin had the milder version: it never string-equals a real `Origin` header, so everything is refused with the allow-list looking correct.
- **Body size** — `MAX_REQUEST_BODY_BYTES` (1 MB) is installed via `app.useBodyParser('json'|'urlencoded', { limit })`. Without it the ceiling was body-parser's 100 KB default, which nobody chose and which the API's own contract already exceeded: `CsvImportDto` advertises 5000 rows (~400 KB), so a full-size import died on a bare 413 from the parser. Registering a parser *claims the slot* — Nest's own `registerParserMiddleware` runs at init and skips a parser already applied — and it inherits `rawBody: true` from the factory options, which every webhook HMAC check depends on. It goes **after** `securityHeaders()`: a 413 never reaches a controller or the global exception filter, so only middleware order keeps the headers on it. The per-DTO `@MaxLength`/`@ArrayMaxSize` caps remain the bound on *work*; this is the bound on *bytes*.
- **Security headers** — `securityHeaders()` (Express middleware, installed before everything) sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `default-src 'none'; frame-ancestors 'none'` CSP, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` denying every device feature; HSTS only in production. It is middleware and not an interceptor on purpose — interceptors run *after* guards, so a 401 from the global `JwtAuthGuard` would go out bare. `/v1/docs` gets a relaxed CSP so Swagger UI renders — which is exactly where `Permissions-Policy` earns its place, since that path runs inline script by necessity.
- **Body shape** — `bodyShapeGuard()` runs *after* the parsers and rejects a body nested past `MAX_BODY_DEPTH` (32) or carrying an object with more than `MAX_OBJECT_KEYS` (1000) keys. The byte cap does not bound either: `{"a":{"a":…` reaches ~50,000 levels inside 400 KB, `JSON.parse` accepts it happily (V8's parser is iterative), and the stack overflow lands later in whatever walks it recursively — `plainToInstance`, nested `class-validator`, `JSON.stringify` in the logging interceptor — as a `RangeError` that escapes the filter's usual path. The width limit is about `forbidNonWhitelisted: true`, which reports every unexpected key and so turns 40,000 of them into an error response bigger than the request. The walk is **iterative with an explicit stack**; making it recursive re-introduces the exact overflow it detects. There is deliberately **no total-value limit** — at 4 bytes a value the 1 MB cap already bounds a body near 250,000, while a 5000-row inventory import is 75,000, so any limit that bites an attacker also rejects the largest import the API advertises. The urlencoded parser gets the matching `qs` bounds (`depth`, `parameterLimit`) so a body is not accepted on one content type and refused on the other.
- **200-body disclosure** — `HttpExceptionFilter` is the only place that decides what detail a client may see, and it only sees *errors*. An endpoint that reports failure inside a `200` (`{ success: false, message }`) routes around it entirely. `channels.testConnection` did: it returned the provider's raw error body — Twilio's echoes the account SID in the request URI, Meta's carries `fbtrace_id` and app-scoped ids — and its `catch` returned `err.message`, which for `fetch` is the full request URL. `providerFailureMessage()` now maps the status to authored prose and the real body goes to the log. Any new "probe" or "test" endpoint shaped this way needs the same treatment.
- **Shutdown** — `enableShutdownHooks()` runs the shutdown hooks on SIGTERM, then `configureHttpServerLifecycle()` closes *idle* keep-alive sockets on the same signal. Without that second step `server.close()` never resolves (Caddy's upstream connections are idle, not gone) and the supervisor SIGKILLs the process mid-job — the exact ungraceful exit the hooks exist to prevent. In-flight requests are untouched and still drain.
- **Shutdown phase ordering is load-bearing.** Nest tears down in a fixed order: `onModuleDestroy` → `beforeApplicationShutdown` → `dispose()` (HTTP server closes, in-flight requests drain) → `onApplicationShutdown` (where `@nestjs/bull` closes its queues). Every teardown in this app used to hook the **first** phase, which is before all three things it has to outlive — so Postgres and Redis were gone before a single job had drained and before one in-flight request had finished, and the drain the hooks exist to allow ran entirely against closed connections. `PrismaService`, `RedisLifecycle` and `AnalyticsCacheLifecycle` therefore hook `onApplicationShutdown`, the **last** phase. `src/common/services/shutdown-ordering.spec.ts` replays all four phases over the real classes and is the only place the ordering is visible; moving any of them back to `onModuleDestroy` is a one-word change that fails there and nowhere else.
- **Worker drain** — `QueueDrainService` (`common/queue/`) hooks `beforeApplicationShutdown` and **locally** pauses every discovered queue (`pause(true, true)`), then waits up to `QUEUE_DRAIN_TIMEOUT_MS` (15s) for active jobs. Bull's own `close()` drains too, but only in phase 4, so until then the workers kept pulling *new* jobs off Redis after the process had been told to die. The pause is local on purpose: a global pause is shared state one restarting instance would leave behind for every other instance and the next boot. Jobs still running at the deadline are left to Bull's stall detection and re-run elsewhere — the timeout bounds how long we *wait*, not how long a job gets.
- **Process safety nets** — `installProcessSafetyNets()` is the last error boundary, installed before anything that can throw asynchronously. `unhandledRejection` is **logged and survived**: Node 15+ defaults to `--unhandled-rejections=throw`, so one floating promise (a fire-and-forget audit write, a cache refresh) took the whole multi-tenant API down, and the log line is the only way anyone learns the promise exists. `uncaughtException` gets the opposite verdict — the stack is gone and whatever it was halfway through stays halfway through, so it logs (installing a handler suppresses Node's own printout) and exits non-zero for the supervisor to restart.
- **Keep-alive** — `keepAliveTimeout` 65s / `headersTimeout` 70s, both above Caddy's upstream idle timeout. Node's 5s default makes the API the side that hangs up, which loses whatever request the proxy had just assigned that socket: a 502 from a healthy backend.

## Auth Flow

- `JwtAuthGuard` is applied **globally** via `APP_GUARD`
- Routes that don't need auth use `@Public()` decorator (webhook endpoints, health check)
- After JWT validation, `TenantInterceptor` extracts `businessId` from the JWT claims and attaches it to the request
- Use `@TenantId()` in controllers to get the scoped `businessId`
- Use `@CurrentUser()` to get the authenticated user

## Module Registration

All 16 feature modules are registered in `app.module.ts`. The registration order matters for dependency injection — `AuthModule` and `TenantModule` first, then messaging, then intelligence, then commerce.

## Queue Configuration

BullMQ is configured globally in `app.module.ts` with:
- 3 retry attempts, exponential backoff starting at 1s. **A `@Process` handler must not swallow** — a handler that resolves on failure gets the job marked complete, so there is no retry and no exhausted-retry ERROR line, and the work is gone with an absence as its only trace. Let it reject; Bull and `QueueTelemetryService` are the error boundary. The two that deliberately swallow (`WebhookDlqProcessor`, `RealtyVisitsProcessor`) capture the failure durably first — a DB-backed retry budget and the realty DLQ respectively — and say so in their doc comments
- Completed jobs retained: last 100; failed jobs retained: last 50
- `timeout: JOB_TIMEOUT_MS` (5 min) — the backstop for a handler that hangs on something with no deadline of its own. Without it such a job never fails, so it never retries: it holds its concurrency slot until the process restarts.
- Redis connection comes from `ConfigService`

`QueueTelemetryService` (global, `common/queue/`) discovers every registered
queue by its `BullQueue_*` provider token (shared with `QueueDrainService` via
`queue-discovery.util.ts`) and logs `failed` / `stalled` / `error`. A job that exhausts its retries logs at ERROR — that line is the only
record it existed, since `removeOnFail: 50` trims the payload out of Redis.
`GET /v1/health/ready` reports `queueBacklog` for any queue whose **waiting**
count is over `QUEUE_DEPTH_WARN_THRESHOLD`; a backlog does not make readiness
degrade, since pulling the instance from rotation removes a worker draining it.

**A durable row plus a Redis job is two writes with no transaction across
them.** Any module that writes state to Postgres and then enqueues the job that
acts on it has a window where the row survives and the job does not — a failed
`queue.add`, a crash between the two, a Redis flush or a failover onto an empty
replica. Bull cannot help: the job it would retry never existed. The module owes
that state a time-based recovery sweep, since a stranded row is
indistinguishable from a waiting one except by age. `NotificationService.recoverStuck`
(repeatable `recover-stuck`, every 15 min) is the worked example, including the
ordering rule — **enqueue before writing the status**, because the other order
re-creates the stranding it is fixing.

## Event Bus

`EventEmitterModule` is configured with `wildcard: true` and `.` as delimiter. Event names follow the pattern `resource.action` (e.g., `message.received`, `order.created`). All event payload types are defined in `@gosumo/shared/events`.

## Key Gotchas

- **Never bypass `@TenantId()`** — always extract businessId from the decorator, not from the request body (where a client could forge it)
- **Webhook endpoints must be `@Public()`** — they use their own HMAC signature verification, not JWT
- The `TenantInterceptor` runs after the JWT guard; it only sets `request.businessId` — it does not validate it
- Integration tests need Docker running for testcontainers; run `pnpm docker:up` first
- The Prisma client is in `@gosumo/database`, not in this app; import `PrismaService` from there
