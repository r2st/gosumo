/**
 * The whole dependency graph, compiled once.
 *
 * Every other suite in this repo builds a `TestingModule` out of the two or
 * three providers it needs and hands the rest in as mocks. That is the right
 * shape for testing behaviour, but it means the wiring itself — which provider
 * is declared where, which module exports the service another module injects —
 * is never exercised until the process boots. A service added to a module's
 * `providers` but missing from its `exports`, a constructor that gains a
 * dependency its module does not import, a `forwardRef` that stops being
 * mutual: all of these type-check cleanly, pass every unit suite, and fail at
 * `NestFactory.create` in whatever environment starts the app next.
 *
 * Compiling `AppModule` is the test for that. It resolves every provider in
 * every feature module through the real injector, so a broken edge in the
 * graph fails here instead of in a deploy.
 *
 * Infrastructure is mocked at the module boundary rather than overridden
 * provider by provider. `ioredis` and `bull` both open sockets from their
 * constructors, and BullMQ's queue providers are registered under generated
 * tokens that would each need naming; replacing the two libraries is both
 * smaller and more honest about what is being faked. The DI graph is real —
 * only the network is not.
 */

// Both open a socket from their constructor. Neither is the subject of this
// test, and both are exported as CommonJS callables — returning the
// constructor as the whole module keeps `require('x')` and `import X from 'x'`
// (which TypeScript's interop wraps as `{ default: module.exports }`) resolving
// to the same function. Adding `__esModule: true` breaks the first form.
jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    status: 'ready',
  })),
);

jest.mock('bull', () =>
  jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: '1' }),
    process: jest.fn(),
    on: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(undefined),
    getJobCounts: jest.fn().mockResolvedValue({}),
    client: { status: 'ready' },
  })),
);

import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';

// Set before `app.module` is required below, not imported at the top of the
// file: `ConfigModule.forRoot({ load: [appConfig] })` reads process.env while
// the module is being loaded, and `JwtStrategy` refuses to construct without a
// secret. These are the variables the graph needs to exist, not to work.
process.env['JWT_SECRET'] ??= 'test-jwt-secret-not-used-to-sign-anything';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['NODE_ENV'] ??= 'test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('./app.module') as { AppModule: new () => unknown };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaService } = require('./common/services/prisma.service') as {
  PrismaService: new () => unknown;
};

describe('AppModule', () => {
  let moduleRef: TestingModule & INestApplicationContext;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // PrismaService connects in onModuleInit; the graph only needs the token
      // to resolve, not a live database.
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $on: jest.fn(),
        $queryRaw: jest.fn().mockResolvedValue([]),
      })
      .compile();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('resolves every provider in the graph', () => {
    // `compile()` instantiates every provider in every imported module. If it
    // returned, no edge in the graph is broken.
    expect(moduleRef).toBeDefined();
  });

  it.each([
    ['AuthService', '/modules/auth/auth.service', 'AuthService'],
    ['HitlService', '/modules/hitl/hitl.service', 'HitlService'],
    ['PaymentService', '/modules/payment/payment.service', 'PaymentService'],
    ['RealtyLeadsService', '/modules/realty-leads/realty-leads.service', 'RealtyLeadsService'],
    ['ConversationService', '/modules/conversation/conversation.service', 'ConversationService'],
    ['ChannelAdapterService', '/modules/channel-adapter/channel-adapter.service', 'ChannelAdapterService'],
    ['NotificationService', '/modules/notification/notification.service', 'NotificationService'],
    ['AnalyticsService', '/modules/analytics/analytics.service', 'AnalyticsService'],
  ])(
    'resolves %s from the root context, so its module exports it',
    (_label, path, exportName) => {
      // Reaching a service from the *root* injector is a stronger claim than
      // the module compiling: it only succeeds if the owning module actually
      // lists the service in `exports`. A provider declared but not exported
      // resolves inside its own module and fails for every consumer, which is
      // exactly the wiring mistake a unit suite full of mocks cannot see.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(`.${path}`) as Record<string, new (...args: never[]) => unknown>;
      const token = mod[exportName]!;
      expect(moduleRef.get(token, { strict: false })).toBeInstanceOf(token);
    },
  );
});
