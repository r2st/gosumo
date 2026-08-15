/**
 * A dead letter carries a captured Node stack. It must not carry it back out.
 *
 * `RealtyHardeningController` returns what `RealtyDlqService` returns, with no
 * DTO in between — so a raw `realty_dead_letters` row put `error_stack` on the
 * wire: absolute `/opt/gosumo/...` paths, the internal module layout, and the
 * `node_modules` frames of whatever failed. None of those routes carries a
 * `@Roles()` guard, so every authenticated user of the business could read it,
 * and `GET realty/ops/dlq` served it for every parked entry at once.
 *
 * The stack is still written on capture — it is what we debug from. These pin
 * the boundary: it stops at the service.
 */
import { DeadLetterStatus } from '@prisma/client';
import { RealtyDlqService } from './realty-dlq.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const DL_ID = '00000000-0000-4000-a000-0000000000aa';

/** A realistic capture: absolute deployment paths and dependency frames. */
const STACK = [
  'Error: getaddrinfo ENOTFOUND wa.internal',
  '    at /opt/gosumo/apps/api/dist/modules/realty-sitevisits/realty-sitevisits.processor.js:88:19',
  '    at /opt/gosumo/node_modules/.pnpm/axios@1.7.2/node_modules/axios/lib/adapters/http.js:512:11',
].join('\n');

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: DL_ID,
    business_id: BIZ,
    source: 'realty-sitevisits',
    operation: 'realty.visit.reminder',
    payload: { visitId: 'v1' },
    error_message: 'getaddrinfo ENOTFOUND wa.internal',
    error_stack: STACK,
    attempts: 3,
    status: DeadLetterStatus.PENDING,
    resolution: null,
    correlation_id: null,
    lead_id: null,
    conversation_id: null,
    replayed_at: null,
    resolved_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Every route returns JSON — check what a caller would actually receive. */
const wire = (value: unknown): string => JSON.stringify(value);

describe('RealtyDlqService — dead letters leave without their stack', () => {
  let repo: {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    countByStatus: jest.Mock;
    update: jest.Mock;
    claimForReplay: jest.Mock;
  };
  let service: RealtyDlqService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue(makeEntry()),
      findById: jest.fn().mockResolvedValue(makeEntry()),
      list: jest.fn().mockResolvedValue([makeEntry(), makeEntry({ id: 'second' })]),
      countByStatus: jest.fn().mockResolvedValue(0),
      update: jest
        .fn()
        .mockImplementation((_b, _id, data) => makeEntry({ ...data })),
      claimForReplay: jest.fn().mockResolvedValue(true),
    };
    service = new RealtyDlqService(
      repo as never,
      { emit: jest.fn() } as never,
    );
  });

  it('strips the stack from a single entry', async () => {
    const entry = await service.get(BIZ, DL_ID);

    expect(entry).not.toHaveProperty('error_stack');
    expect(wire(entry)).not.toContain('/opt/gosumo');
  });

  it('strips the stack from every row of a list', async () => {
    // The list route was the worse of the two: one call, every parked stack.
    const entries = await service.list(BIZ);

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty('error_stack');
    }
    expect(wire(entries)).not.toContain('/opt/gosumo');
    expect(wire(entries)).not.toContain('node_modules');
  });

  it('strips the stack from a successful replay', async () => {
    service.registerReplayer('realty.visit.reminder', async () => undefined);

    const entry = await service.replay(BIZ, DL_ID);

    expect(entry).not.toHaveProperty('error_stack');
  });

  it('strips the stack from a failed replay', async () => {
    // The failure path re-reads the row after writing the new error, so it is
    // its own route back out.
    service.registerReplayer('realty.visit.reminder', async () => {
      throw new Error('still broken');
    });

    const entry = await service.replay(BIZ, DL_ID);

    expect(entry).not.toHaveProperty('error_stack');
    expect(wire(entry)).not.toContain('/opt/gosumo');
  });

  it('strips the stack from a resolve', async () => {
    const entry = await service.resolve(BIZ, DL_ID, DeadLetterStatus.RESOLVED, 'handled');

    expect(entry).not.toHaveProperty('error_stack');
  });

  it('still keeps the operator-facing error message', async () => {
    // Redaction must not take the part that makes a dead letter judgeable.
    const entry = await service.get(BIZ, DL_ID);

    expect(entry.error_message).toBe('getaddrinfo ENOTFOUND wa.internal');
    expect(entry.payload).toEqual({ visitId: 'v1' });
    expect(entry.attempts).toBe(3);
  });

  it('still writes the stack on capture', async () => {
    // The point is that we keep debugging it — from the row and the log, not
    // from an API response.
    await service.capture(BIZ, {
      source: 'realty-sitevisits',
      operation: 'realty.visit.reminder',
      payload: {},
    }, new Error('boom'), 3);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ errorStack: expect.stringContaining('Error: boom') }),
    );
  });

  it('hands a replayer a redacted entry too', async () => {
    let seen: unknown;
    service.registerReplayer('realty.visit.reminder', async (_biz, _payload, entry) => {
      seen = entry;
    });

    await service.replay(BIZ, DL_ID);

    expect(seen).not.toHaveProperty('error_stack');
  });
});
