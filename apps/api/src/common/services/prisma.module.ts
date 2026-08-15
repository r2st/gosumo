import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global because a connection pool is only a pool if everyone shares one.
 *
 * `PrismaService` used to be listed in the `providers` array of each feature
 * module that injected it — 39 of them. A provider in `providers` is
 * module-scoped, so that did not share one client between them: Nest
 * constructed 39 separate `PrismaClient`s, each opening and holding its own
 * pool against the same database.
 *
 * The cost was measured on the production host, which has 2 vCPUs and a
 * PostgreSQL with max_connections=50 shared with another application: the API
 * held 38 connections while completely idle — one per client from `$connect()`
 * in `onModuleInit` — out of a 50-connection budget. Idle was the *good* case.
 * Under concurrency each of those pools grows independently to its own limit,
 * so the ceiling was 39 pools deep, not one: far past what the server will
 * grant, and the failure is not a slow query but `FATAL: sorry, too many
 * clients already` for whoever asks next — including `prisma migrate deploy`,
 * which needs an ordinary connection to run at all.
 *
 * With one shared instance the process holds one pool, bounded by
 * `DATABASE_CONNECTION_LIMIT` (see PrismaService).
 *
 * Being `@Global()`, importing this module anywhere is unnecessary: AppModule
 * imports it once and every module can inject `PrismaService`. Adding
 * `PrismaService` back to a feature module's `providers` silently reintroduces
 * the bug — that module gets a private client again, and nothing fails loudly.
 * `prisma-module.spec.ts` guards against exactly that.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
