import { Logger } from '@nestjs/common';
import {
  PrismaService,
  withConnectionLimit,
  DEFAULT_CONNECTION_LIMIT,
} from './prisma.service';

/**
 * PrismaService only binds the Prisma client's connection lifecycle to Nest's.
 * The tests stub $connect/$disconnect on the instance so nothing reaches a real
 * database, and pin that a connection failure propagates — bootstrapping with a
 * dead database must abort rather than serve traffic that will fail per-request.
 */
describe('PrismaService', () => {
  let service: PrismaService;
  let connect: jest.Mock;
  let disconnect: jest.Mock;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new PrismaService();
    connect = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, { $connect: connect, $disconnect: disconnect });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('onModuleInit', () => {
    it('opens the connection', async () => {
      await service.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('logs only after the connection is actually open', async () => {
      let connected = false;
      connect.mockImplementation(async () => {
        connected = true;
      });
      log.mockImplementation(() => {
        expect(connected).toBe(true);
      });
      await service.onModuleInit();
      expect(log).toHaveBeenCalledWith('Prisma connected to database');
    });

    it('propagates a connection failure so bootstrap aborts', async () => {
      connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationShutdown', () => {
    it('closes the connection', async () => {
      await service.onApplicationShutdown();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Prisma disconnected from database');
    });

    it('propagates a disconnect failure rather than hiding a leaked pool', async () => {
      disconnect.mockRejectedValueOnce(new Error('pool busy'));
      await expect(service.onApplicationShutdown()).rejects.toThrow('pool busy');
    });
  });

  it('implements both Nest lifecycle hooks', () => {
    expect(typeof service.onModuleInit).toBe('function');
    expect(typeof service.onApplicationShutdown).toBe('function');
  });

  /**
   * The phase, not just the method. Nest runs `onModuleDestroy` *first* —
   * before it closes the HTTP server and before `@nestjs/bull` closes its
   * queues — so a disconnect there pulled the pool out from under every
   * request and job that was still draining. Naming the wrong hook is a
   * one-word change with no local symptom, so it is pinned here.
   */
  it('does not disconnect in the first shutdown phase', () => {
    expect(
      (service as unknown as { onModuleDestroy?: unknown }).onModuleDestroy,
    ).toBeUndefined();
  });
});

/**
 * The pool is sized against the *database's* budget, not this process's CPU
 * count. Production runs a 2-vCPU host against a PostgreSQL with
 * max_connections=50 shared with another application, so Prisma's own
 * `num_cpus * 2 + 1` default is sizing on the wrong variable.
 */
describe('withConnectionLimit', () => {
  const base = 'postgresql://u:p@127.0.0.1:5433/gosumo_db';

  it('appends the default limit when the URL does not set one', () => {
    const url = new URL(withConnectionLimit(base) as string);
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_CONNECTION_LIMIT));
  });

  it('keeps the rest of the URL intact', () => {
    const url = new URL(withConnectionLimit(base) as string);
    expect(url.protocol).toBe('postgresql:');
    expect(url.host).toBe('127.0.0.1:5433');
    expect(url.pathname).toBe('/gosumo_db');
    expect(url.username).toBe('u');
  });

  it('preserves query parameters that are already there', () => {
    const url = new URL(withConnectionLimit(`${base}?schema=public&sslmode=require`) as string);
    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('connection_limit')).toBe(String(DEFAULT_CONNECTION_LIMIT));
  });

  it('leaves an operator-set connection_limit alone', () => {
    const explicit = `${base}?connection_limit=3`;
    expect(withConnectionLimit(explicit, 25)).toBe(explicit);
  });

  it('honours a caller-supplied limit', () => {
    const url = new URL(withConnectionLimit(base, 4) as string);
    expect(url.searchParams.get('connection_limit')).toBe('4');
  });

  it.each([0, -1, 1.5, Number.NaN])('ignores the nonsensical limit %p', (limit) => {
    expect(withConnectionLimit(base, limit)).toBe(base);
  });

  it('returns undefined when DATABASE_URL is unset, so Prisma reports it', () => {
    // Throwing here would surface inside Nest's DI resolution as an unrelated
    // provider failure; Prisma's own $connect error names the variable.
    expect(withConnectionLimit(undefined)).toBeUndefined();
    expect(withConnectionLimit('')).toBeUndefined();
  });

  it('passes through a non-PostgreSQL URL untouched', () => {
    expect(withConnectionLimit('file:./dev.db')).toBe('file:./dev.db');
  });

  it('passes through an unparseable URL rather than throwing', () => {
    // A malformed host — the failure belongs to Prisma's connect-time
    // diagnostic, not to a URL parse error thrown during DI resolution.
    expect(withConnectionLimit('postgresql://[bad')).toBe('postgresql://[bad');
  });

  it('defaults well under the 50-connection budget the server actually has', () => {
    // A regression here is not a test failure in production, it is
    // `FATAL: sorry, too many clients already` for whoever connects next —
    // including prisma migrate deploy.
    expect(DEFAULT_CONNECTION_LIMIT).toBeLessThanOrEqual(20);
    expect(DEFAULT_CONNECTION_LIMIT).toBeGreaterThan(0);
  });
});
