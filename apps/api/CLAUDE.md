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
- CORS — origins come from `CORS_ORIGIN` (comma-separated for a list). When it is unset the origin falls back to `*` and credentials are switched **off**, since `Access-Control-Allow-Origin: *` with credentials is the one combination the CORS spec forbids.
- CORS configured for dashboard origin

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
- Redis connection comes from `ConfigService`

## Event Bus

`EventEmitterModule` is configured with `wildcard: true` and `.` as delimiter. Event names follow the pattern `resource.action` (e.g., `message.received`, `order.created`). All event payload types are defined in `@gosumo/shared/events`.

## Key Gotchas

- **Never bypass `@TenantId()`** — always extract businessId from the decorator, not from the request body (where a client could forge it)
- **Webhook endpoints must be `@Public()`** — they use their own HMAC signature verification, not JWT
- The `TenantInterceptor` runs after the JWT guard; it only sets `request.businessId` — it does not validate it
- Integration tests need Docker running for testcontainers; run `pnpm docker:up` first
- The Prisma client is in `@gosumo/database`, not in this app; import `PrismaService` from there
