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
- **Security headers** — `securityHeaders()` (Express middleware, installed before everything) sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `default-src 'none'; frame-ancestors 'none'` CSP, and `Referrer-Policy: no-referrer`; HSTS only in production. It is middleware and not an interceptor on purpose — interceptors run *after* guards, so a 401 from the global `JwtAuthGuard` would go out bare. `/v1/docs` gets a relaxed CSP so Swagger UI renders.
- **Shutdown** — `enableShutdownHooks()` runs `onModuleDestroy` on SIGTERM, then `configureHttpServerLifecycle()` closes *idle* keep-alive sockets on the same signal. Without that second step `server.close()` never resolves (Caddy's upstream connections are idle, not gone) and the supervisor SIGKILLs the process mid-job — the exact ungraceful exit the hooks exist to prevent. In-flight requests are untouched and still drain.
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
- 3 retry attempts, exponential backoff starting at 1s
- Completed jobs retained: last 100; failed jobs retained: last 50
- `timeout: JOB_TIMEOUT_MS` (5 min) — the backstop for a handler that hangs on something with no deadline of its own. Without it such a job never fails, so it never retries: it holds its concurrency slot until the process restarts.
- Redis connection comes from `ConfigService`

`QueueTelemetryService` (global, `common/queue/`) discovers every registered
queue by its `BullQueue_*` provider token and logs `failed` / `stalled` /
`error`. A job that exhausts its retries logs at ERROR — that line is the only
record it existed, since `removeOnFail: 50` trims the payload out of Redis.
`GET /v1/health/ready` reports `queueBacklog` for any queue whose **waiting**
count is over `QUEUE_DEPTH_WARN_THRESHOLD`; a backlog does not make readiness
degrade, since pulling the instance from rotation removes a worker draining it.

## Event Bus

`EventEmitterModule` is configured with `wildcard: true` and `.` as delimiter. Event names follow the pattern `resource.action` (e.g., `message.received`, `order.created`). All event payload types are defined in `@gosumo/shared/events`.

## Key Gotchas

- **Never bypass `@TenantId()`** — always extract businessId from the decorator, not from the request body (where a client could forge it)
- **Webhook endpoints must be `@Public()`** — they use their own HMAC signature verification, not JWT
- The `TenantInterceptor` runs after the JWT guard; it only sets `request.businessId` — it does not validate it
- Integration tests need Docker running for testcontainers; run `pnpm docker:up` first
- The Prisma client is in `@gosumo/database`, not in this app; import `PrismaService` from there
