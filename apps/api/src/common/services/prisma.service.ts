import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { createQueryTimingMiddleware } from './query-timing.middleware';
import { createSoftDeleteMiddleware } from './soft-delete.middleware';

/**
 * Connections this process will open at most, when DATABASE_URL does not say.
 *
 * Prisma's own default is `num_physical_cpus * 2 + 1`, which sizes the pool to
 * the app's CPU and ignores the database's budget. That is the wrong variable
 * here: production runs on a 2-vCPU host whose PostgreSQL has
 * max_connections=50, *shared with another application*. Sizing to the shared
 * budget rather than to our core count is what keeps a busy API from starving
 * the neighbour — or from failing its own migrations, which need a free
 * connection like anything else.
 */
export const DEFAULT_CONNECTION_LIMIT = 10;

/**
 * Append an explicit `connection_limit` to a Prisma datasource URL.
 *
 * Exported for tests, and deliberately total: it never throws on a malformed
 * URL, because a bad DATABASE_URL should fail at $connect with Prisma's own
 * diagnostic rather than as a URL parse error thrown from a constructor
 * during module resolution, which Nest reports as an unrelated DI failure.
 *
 * An explicit `connection_limit` already in the URL always wins — that is the
 * operator overriding us on purpose.
 */
export function withConnectionLimit(
  rawUrl: string | undefined,
  limit: number = DEFAULT_CONNECTION_LIMIT,
): string | undefined {
  if (!rawUrl) return undefined;
  // Only PostgreSQL URLs take this parameter; leave anything else untouched.
  if (!/^postgres(ql)?:\/\//i.test(rawUrl)) return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (url.searchParams.has('connection_limit')) return rawUrl;
  if (!Number.isInteger(limit) || limit < 1) return rawUrl;

  url.searchParams.set('connection_limit', String(limit));
  return url.toString();
}

/** Read the pool size override, ignoring values that are not a positive integer. */
function configuredLimit(): number {
  const raw = process.env['DATABASE_CONNECTION_LIMIT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONNECTION_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CONNECTION_LIMIT;
  return parsed;
}

/**
 * The application's one Prisma client.
 *
 * Provided *only* by the global PrismaModule. A `PrismaService` entry in a
 * feature module's `providers` array does not share this instance — Nest builds
 * that module its own, with its own connection pool — so adding one back
 * multiplies the process's connection count by the number of modules that do
 * it. See PrismaModule for what that cost us.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = withConnectionLimit(process.env['DATABASE_URL'], configuredLimit());
    super(url ? { datasources: { db: { url } } } : {});

    // Order is the contract. `$use` wraps in registration order, so the first
    // registered is the outermost link: timing has to see the query as the
    // caller issued it *and* as the scope rewrote it, which means it must be
    // outside the rewrite. Swapping these two lines would still work and would
    // still report a number — just not the number the caller waited for.
    this.$use(createQueryTimingMiddleware());
    this.$use(createSoftDeleteMiddleware());
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected to database');
  }

  /**
   * Disconnect in the **last** shutdown phase, not the first.
   *
   * This was `onModuleDestroy`, which Nest runs before it closes the HTTP
   * server and before `@nestjs/bull` closes its queues:
   *
   *   1. `onModuleDestroy`            ← the pool was returned here
   *   2. `beforeApplicationShutdown`  — {@link QueueDrainService} drains workers
   *   3. `dispose()`                  — HTTP server closes, in-flight requests drain
   *   4. `onApplicationShutdown`      — queues close
   *
   * So every request and every job that was still being drained in phases 2–4
   * — the drain the shutdown hooks exist to allow — ran against a client that
   * had already been disconnected, and failed on a dead connection instead of
   * finishing. The symptom is the one graceful shutdown is supposed to remove:
   * work lost at restart, with an error that names Prisma rather than the
   * restart.
   *
   * Phase 4 is after all three, so nothing is still using the pool when it goes.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected from database');
  }
}
