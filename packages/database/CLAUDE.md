# Package: @gosumo/database

The Prisma schema, generated Prisma client, and database migration history. The single source of truth for the GoSumo PostgreSQL schema. All other packages import `PrismaService` and the generated types from here.

## Purpose

Manage the PostgreSQL schema via Prisma, own the migration history, and expose a `PrismaService` that other NestJS modules inject. Also provides the `withTenant()` helper that sets the RLS session variable before any tenant query.

## Commands

```bash
# From repo root
pnpm db:migrate               # Apply pending migrations (dev): prisma migrate dev
pnpm db:generate              # Regenerate Prisma client after schema changes
pnpm db:seed                  # Run prisma/seed.ts

# From packages/database/
pnpm migrate:dev              # prisma migrate dev
pnpm migrate:deploy           # prisma migrate deploy (production)
pnpm generate                 # prisma generate
pnpm studio                   # Open Prisma Studio (DB browser) at localhost:5555
pnpm seed                     # Seed dev data
```

## Key Files

```
packages/database/
  prisma/
    schema.prisma           # Canonical schema — single source of truth
    migrations/             # Migration SQL files (auto-generated; do NOT edit)
    seed.ts                 # Dev seed data script
  src/
    index.ts                # Exports PrismaService and all Prisma generated types
    prisma.service.ts       # NestJS injectable wrapper + withTenant() helper
```

## Using PrismaService

```typescript
import { PrismaService } from '@gosumo/database';

@Injectable()
export class MyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByBusiness(businessId: string) {
    // Always use withTenant() for tenant-scoped queries to set RLS context
    return this.prisma.withTenant(businessId, () =>
      this.prisma.conversations.findMany({
        where: { business_id: businessId },
      })
    );
  }
}
```

## withTenant() Helper

Sets the PostgreSQL session variable `app.current_business_id` inside a transaction, activating Row-Level Security policies:

```typescript
async withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return this.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_business_id', ${businessId}, TRUE)`;
    return fn();
  });
}
```

## Schema Overview

| Layer | Tables |
|---|---|
| Platform | `businesses`, `team_members`, `clients`, `consumer_users` |
| Messaging | `channel_accounts`, `channel_contacts`, `conversations`, `messages`, `file_uploads`, `notification_templates`, `webhook_events` |
| Intelligence | `business_rules`, `ai_decisions`, `ai_precedents`, `vector_embeddings_metadata`, `tasks` |
| Commerce | `catalog_categories`, `catalog_items`, `catalog_variants`, `catalog_packages`, `orders`, `payments`, `refunds`, `shipping_addresses`, `shipping_options`, `shipments`, `bookings` |
| Engagement | `campaigns` |
| Operations | `analytics_events`, `audit_logs` |

## Key Gotchas

- **After any change to `schema.prisma`, always run `pnpm db:generate`** to regenerate the Prisma client — forgetting this causes TypeScript errors or runtime mismatches
- **Never edit migration files** in `prisma/migrations/` — if a migration needs changing, create a new migration
- **`analytics_events` and `messages`** are partitioned by `created_at` month in production via raw SQL migrations (`0010_partition_messages.sql`, `0011_partition_analytics_events.sql`) — Prisma does not know about partitioning; queries must always include a `created_at` range filter for partition pruning
- **`audit_logs` is append-only** — PostgreSQL rules (`audit_logs_no_update`, `audit_logs_no_delete`) enforce this at the DB level; never attempt UPDATE/DELETE on this table
- **RLS policies** are enabled on all tenant tables via migration `0001_enable_rls.sql`. If you bypass `withTenant()` and query directly, RLS will block all reads (returns empty results, not errors)
- **UUID PKs** everywhere — default via `uuid_generate_v4()` DB function from the `uuid-ossp` extension; never use `@default(uuid())` (Prisma's client-side UUID) as it bypasses the DB function
- `Decimal` fields in Prisma map to JavaScript's `Decimal` type (from `decimal.js`) — use `.toNumber()` only for display; keep as `Decimal` for arithmetic to avoid floating-point errors
- **Soft delete pattern:** all business tables have `deleted_at DateTime?` — always add `WHERE deleted_at IS NULL` (or Prisma `{ where: { deleted_at: null } }`) to queries unless explicitly fetching deleted records
