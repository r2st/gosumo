/**
 * Every list hook must fetch through `apiPaginated`, not `apiRequest`.
 *
 * This is the guard for a bug that reached production. `apiRequest<T>` ends in
 * `return data as T` — a cast, not a conversion. Ask it for a
 * `PaginatedResponse<T>` from a backend that answers with flat fields
 * (`{ data, total, page, limit, totalPages }`, which is what NestJS services
 * like `OrderService.listOrders` return) and you get an object whose
 * `pagination` is `undefined` while the compiler is certain it is not.
 * `app/(dashboard)/orders/page.tsx` then read `data.pagination.total` and
 * threw for any business with at least one order.
 *
 * Per-hook tests cannot catch this: they mock the client, so they never see
 * the server's real shape. Page tests cannot catch it either: their fixtures
 * supply the nested shape the *type* promised. The only durable check is
 * structural — assert at the source that no list hook takes the casting path.
 *
 * `useNotifications` is the deliberate exception, and it is listed here so the
 * exemption is visible rather than looking like an oversight: that endpoint
 * returns an extra `unreadCount` beside the page, the hook reads only `data`,
 * and its type says so instead of claiming a `PaginatedResponse`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOKS_DIR = join(process.cwd(), 'src/hooks');

/** Hooks that fetch a paginated collection, and the route each one reads. */
const PAGINATED_HOOKS: { file: string; route: string }[] = [
  { file: 'use-orders.ts', route: '/orders' },
  { file: 'use-catalog.ts', route: '/catalog/items' },
  { file: 'use-bookings.ts', route: '/bookings' },
  { file: 'use-payments.ts', route: '/payments' },
  { file: 'use-settings.ts', route: '/auth/team' },
  { file: 'use-settings.ts', route: '/channels' },
  { file: 'use-integrations.ts', route: '/api-keys' },
];

function source(file: string): string {
  return readFileSync(join(HOOKS_DIR, file), 'utf8');
}

describe('paginated hooks', () => {
  it.each(PAGINATED_HOOKS)('$file fetches $route through apiPaginated', ({ file, route }) => {
    const line = source(file)
      .split('\n')
      .find((l) => l.includes(`\`${route}$`) || l.includes(`'${route}'`));

    expect(line, `no fetch of ${route} found in ${file}`).toBeDefined();
    expect(line).toContain('apiPaginated');
  });

  it('no hook casts a response to PaginatedResponse', () => {
    // The cast is the bug in one grep-able form. If a new list hook needs a
    // shape `apiPaginated` cannot produce, give it an honest inline type — as
    // use-notifications.ts does — rather than this claim.
    const offenders = PAGINATED_HOOKS.map(({ file }) => file)
      .concat('use-notifications.ts')
      .filter((file, i, all) => all.indexOf(file) === i)
      .filter((file) => source(file).includes('apiRequest<PaginatedResponse'));

    expect(offenders).toEqual([]);
  });

  it('documents why useNotifications is exempt', () => {
    const src = source('use-notifications.ts');

    // It describes the server's actual body inline instead of importing the
    // envelope type it does not receive.
    expect(src).not.toContain("from '@/lib/types'");
    expect(src).toContain('unreadCount?: number');
  });
});
