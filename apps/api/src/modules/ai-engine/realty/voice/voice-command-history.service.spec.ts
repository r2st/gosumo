/**
 * VoiceCommandHistoryService unit tests.
 *
 * Two properties carry the weight here.
 *
 * `record` is best-effort by contract: it is called on the way out of a voice
 * command that has already been executed, so throwing would fail a command that
 * actually succeeded. Every write path therefore has to swallow.
 *
 * `list` reads back off `audit_logs`, whose `resource_after` is untyped JSON
 * written by past versions of this service. Every field it pulls out is
 * `typeof`-guarded, and those guards are the only thing standing between a row
 * written by an older shape and a crashed history panel.
 */

import { AuditAction } from '@gosumo/database';
import { Prisma } from '@prisma/client';

import {
  VoiceCommandHistoryService,
  type VoiceCommandRecordInput,
} from './voice-command-history.service';
import type { PrismaService } from '../../../../common/services/prisma.service';
import type { BrokerCommand } from './broker-command.parser';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = '00000000-0000-4000-c000-000000000001';

const PAUSE_COMMAND: BrokerCommand = {
  kind: 'PAUSE_FOLLOWUPS',
  leadName: 'Ramesh',
};

function input(
  overrides: Partial<VoiceCommandRecordInput> = {},
): VoiceCommandRecordInput {
  return {
    businessId: BUSINESS_ID,
    userId: USER_ID,
    transcription: 'pause followups for Ramesh',
    command: PAUSE_COMMAND,
    status: 'executed',
    detail: 'Paused 3 scheduled follow-ups',
    ...overrides,
  };
}

describe('VoiceCommandHistoryService', () => {
  let service: VoiceCommandHistoryService;
  let prisma: {
    audit_logs: { create: jest.Mock; findMany: jest.Mock };
  };
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      audit_logs: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new VoiceCommandHistoryService(
      prisma as unknown as PrismaService,
    );
    errorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The `data` payload of the single audit_logs insert. */
  function writtenRow(): Record<string, unknown> {
    return prisma.audit_logs.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
  }

  function resourceAfter(): Record<string, unknown> {
    return writtenRow().resource_after as Record<string, unknown>;
  }

  // ─────────────────────────────────────────────
  // record
  // ─────────────────────────────────────────────

  describe('record', () => {
    it('writes the command to the tenant’s audit log', async () => {
      await service.record(input());

      expect(writtenRow()).toMatchObject({
        business_id: BUSINESS_ID,
        actor_type: 'TEAM_MEMBER',
        actor_id: USER_ID,
        action: AuditAction.UPDATE,
        resource_type: 'realty_voice_command',
      });
    });

    it('records the transcript, command kind, status and detail', async () => {
      await service.record(input());

      expect(resourceAfter()).toMatchObject({
        transcription: 'pause followups for Ramesh',
        kind: 'PAUSE_FOLLOWUPS',
        status: 'executed',
        detail: 'Paused 3 scheduled follow-ups',
      });
    });

    it('records the parsed command payload', async () => {
      await service.record(input());

      expect(resourceAfter().command).toEqual(PAUSE_COMMAND);
    });

    it('falls back to a null actor when no user is attributed', async () => {
      await service.record(input({ userId: undefined }));

      expect(writtenRow().actor_id).toBeNull();
    });

    it('treats an explicitly null user as unattributed', async () => {
      await service.record(input({ userId: null }));

      expect(writtenRow().actor_id).toBeNull();
    });

    it('records an unparsed transcript as an UNKNOWN command', async () => {
      await service.record(
        input({ command: null, status: 'not_understood', detail: 'no match' }),
      );

      expect(resourceAfter().kind).toBe('UNKNOWN');
      expect(resourceAfter().command).toBe(Prisma.JsonNull);
    });

    it('carries the correlation id when one is supplied', async () => {
      await service.record(input({ correlationId: 'corr-1' }));

      expect(writtenRow().request_id).toBe('corr-1');
    });

    it('falls back to a null correlation id', async () => {
      await service.record(input({ correlationId: undefined }));

      expect(writtenRow().request_id).toBeNull();
    });

    it('builds a human-readable description', async () => {
      await service.record(input());

      expect(writtenRow().description).toBe(
        'Broker voice command · PAUSE_FOLLOWUPS · executed: Paused 3 scheduled follow-ups',
      );
    });

    it('describes an unparsed command as UNKNOWN', async () => {
      await service.record(
        input({ command: null, status: 'not_understood', detail: 'no match' }),
      );

      expect(writtenRow().description).toBe(
        'Broker voice command · UNKNOWN · not_understood: no match',
      );
    });

    it.each([
      ['executed'],
      ['not_understood'],
      ['unresolved'],
      ['failed'],
    ] as const)('records the %s outcome', async (status) => {
      await service.record(input({ status }));

      expect(resourceAfter().status).toBe(status);
    });

    it('never throws when the audit write fails', async () => {
      // The command already ran; failing here would report a success as a failure.
      prisma.audit_logs.create.mockRejectedValue(new Error('db down'));

      await expect(service.record(input())).resolves.toBeUndefined();
    });

    it('logs the reason the audit write failed', async () => {
      prisma.audit_logs.create.mockRejectedValue(new Error('db down'));

      await service.record(input());

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });

    it('stringifies a non-Error write failure', async () => {
      prisma.audit_logs.create.mockRejectedValue('connection reset');

      await service.record(input());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection reset'),
      );
    });
  });

  // ─────────────────────────────────────────────
  // list
  // ─────────────────────────────────────────────

  describe('list', () => {
    function auditRow(
      after: unknown,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id: 'log-1',
        resource_after: after,
        description: 'fallback description',
        created_at: new Date('2026-05-01T10:00:00Z'),
        ...overrides,
      };
    }

    it('scopes the query to the tenant and to voice-command rows', async () => {
      await service.list(BUSINESS_ID);

      expect(prisma.audit_logs.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            business_id: BUSINESS_ID,
            resource_type: 'realty_voice_command',
          },
          orderBy: { created_at: 'desc' },
        }),
      );
    });

    it('defaults to the 50 most recent commands', async () => {
      await service.list(BUSINESS_ID);

      expect(prisma.audit_logs.findMany.mock.calls[0][0].take).toBe(50);
    });

    it('honours an explicit limit', async () => {
      await service.list(BUSINESS_ID, 10);

      expect(prisma.audit_logs.findMany.mock.calls[0][0].take).toBe(10);
    });

    it('caps the limit at 200', async () => {
      await service.list(BUSINESS_ID, 5000);

      expect(prisma.audit_logs.findMany.mock.calls[0][0].take).toBe(200);
    });

    it.each([[0], [-5]])('raises a limit of %s to 1', async (limit) => {
      await service.list(BUSINESS_ID, limit);

      expect(prisma.audit_logs.findMany.mock.calls[0][0].take).toBe(1);
    });

    it('maps a well-formed row', async () => {
      prisma.audit_logs.findMany.mockResolvedValue([
        auditRow({
          transcription: 'pause followups for Ramesh',
          kind: 'PAUSE_FOLLOWUPS',
          status: 'executed',
          detail: 'Paused 3',
        }),
      ]);

      await expect(service.list(BUSINESS_ID)).resolves.toEqual([
        {
          id: 'log-1',
          transcription: 'pause followups for Ramesh',
          kind: 'PAUSE_FOLLOWUPS',
          status: 'executed',
          detail: 'Paused 3',
          createdAt: new Date('2026-05-01T10:00:00Z'),
        },
      ]);
    });

    it('returns an empty feed when nothing has been recorded', async () => {
      await expect(service.list(BUSINESS_ID)).resolves.toEqual([]);
    });

    it('survives a row with no resource_after payload', async () => {
      prisma.audit_logs.findMany.mockResolvedValue([auditRow(null)]);

      await expect(service.list(BUSINESS_ID)).resolves.toEqual([
        {
          id: 'log-1',
          transcription: '',
          kind: 'UNKNOWN',
          status: 'not_understood',
          detail: 'fallback description',
          createdAt: new Date('2026-05-01T10:00:00Z'),
        },
      ]);
    });

    it.each([
      ['transcription', 42, ''],
      ['kind', { nested: true }, 'UNKNOWN'],
      ['status', 7, 'not_understood'],
    ])(
      'falls back when %s is not a string',
      async (field, badValue, expected) => {
        prisma.audit_logs.findMany.mockResolvedValue([
          auditRow({
            transcription: 'x',
            kind: 'PAUSE_FOLLOWUPS',
            status: 'executed',
            detail: 'd',
            [field as string]: badValue,
          }),
        ]);

        const [item] = await service.list(BUSINESS_ID);

        expect((item as unknown as Record<string, unknown>)[field as string]).toBe(
          expected,
        );
      },
    );

    it('falls back to the row description when detail is not a string', async () => {
      prisma.audit_logs.findMany.mockResolvedValue([
        auditRow({ detail: null }),
      ]);

      const [item] = await service.list(BUSINESS_ID);

      expect(item?.detail).toBe('fallback description');
    });

    it('falls back to an empty detail when the description is null too', async () => {
      prisma.audit_logs.findMany.mockResolvedValue([
        auditRow({ detail: null }, { description: null }),
      ]);

      const [item] = await service.list(BUSINESS_ID);

      expect(item?.detail).toBe('');
    });

    it('maps every row in the page', async () => {
      prisma.audit_logs.findMany.mockResolvedValue([
        auditRow({ detail: 'a' }, { id: 'log-1' }),
        auditRow({ detail: 'b' }, { id: 'log-2' }),
      ]);

      const items = await service.list(BUSINESS_ID);

      expect(items.map((i) => i.id)).toEqual(['log-1', 'log-2']);
    });
  });
});
