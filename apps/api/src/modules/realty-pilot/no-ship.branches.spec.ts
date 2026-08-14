/**
 * NoShipService branch coverage — the read side of the ledger, the full
 * guardrail→kind mapping table, and the regression watch's failure handling.
 * `no-ship.service.spec.ts` covers the happy paths.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { NoShipKind } from '@gosumo/shared';
import type { RealtyAiTurnCompletedEvent } from '@gosumo/shared';

import { NoShipService } from './no-ship.service';
import { RealtyPilotRepository } from './realty-pilot.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const CONVERSATION_ID = '00000000-0000-4000-a000-000000000020';

function baseTurn(
  overrides: Partial<RealtyAiTurnCompletedEvent> = {},
): RealtyAiTurnCompletedEvent {
  return {
    id: 'e1',
    timestamp: new Date().toISOString(),
    businessId: BUSINESS_ID,
    correlationId: 'c1',
    type: 'realty.ai.turn_completed',
    leadId: LEAD_ID,
    intent: 'PRICE_INQUIRY',
    routeMode: 'AUTO',
    confidence: 95,
    violations: [],
    blockingViolations: [],
    ...overrides,
  };
}

interface RepositoryMock {
  createNoShipIncident: jest.Mock;
  countNoShipIncidents: jest.Mock;
  countNoShipByKind: jest.Mock;
  listNoShipIncidents: jest.Mock;
}

describe('NoShipService (branches)', () => {
  let service: NoShipService;
  let repository: RepositoryMock;
  let emitter: { emit: jest.Mock };
  let error: jest.SpyInstance;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repository = {
      createNoShipIncident: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: 'inc-1',
          kind: d.kind,
          lead_id: d.leadId ?? null,
          conversation_id: d.conversationId ?? null,
          detail: d.detail,
          source: d.source,
          created_at: new Date('2026-08-01T10:00:00Z'),
        }),
      ),
      countNoShipIncidents: jest.fn().mockResolvedValue(0),
      countNoShipByKind: jest.fn().mockResolvedValue({}),
      listNoShipIncidents: jest.fn().mockResolvedValue([]),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoShipService,
        { provide: RealtyPilotRepository, useValue: repository },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(NoShipService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('reads', () => {
    it('counts incidents for the tenant', async () => {
      repository.countNoShipIncidents.mockResolvedValueOnce(3);
      await expect(service.count(BUSINESS_ID)).resolves.toBe(3);
      expect(repository.countNoShipIncidents).toHaveBeenCalledWith(
        BUSINESS_ID,
        undefined,
      );
    });

    it('passes a since-cutoff through to the count query', async () => {
      const since = new Date('2026-07-01T00:00:00Z');
      await service.count(BUSINESS_ID, since);
      expect(repository.countNoShipIncidents).toHaveBeenCalledWith(
        BUSINESS_ID,
        since,
      );
    });

    it('returns the per-kind breakdown as the repository reports it', async () => {
      repository.countNoShipByKind.mockResolvedValueOnce({
        UNVERIFIED_PRICE: 2,
        RERA_CLAIM: 1,
      });
      await expect(service.countByKind(BUSINESS_ID)).resolves.toEqual({
        UNVERIFIED_PRICE: 2,
        RERA_CLAIM: 1,
      });
    });

    it('passes a since-cutoff through to the per-kind query', async () => {
      const since = new Date('2026-07-01T00:00:00Z');
      await service.countByKind(BUSINESS_ID, since);
      expect(repository.countNoShipByKind).toHaveBeenCalledWith(
        BUSINESS_ID,
        since,
      );
    });

    it('returns an empty list for a clean ledger rather than throwing', async () => {
      await expect(service.list(BUSINESS_ID)).resolves.toEqual([]);
    });

    it('maps snake_case rows onto the DTO, nulls included', async () => {
      const createdAt = new Date('2026-08-01T10:00:00Z');
      repository.listNoShipIncidents.mockResolvedValueOnce([
        {
          id: 'inc-1',
          kind: 'UNVERIFIED_PRICE',
          lead_id: LEAD_ID,
          conversation_id: null,
          detail: 'quoted a price absent from the sheet',
          source: 'realty-ai:auto_send',
          created_at: createdAt,
        },
      ]);
      await expect(service.list(BUSINESS_ID)).resolves.toEqual([
        {
          id: 'inc-1',
          kind: 'UNVERIFIED_PRICE',
          leadId: LEAD_ID,
          conversationId: null,
          detail: 'quoted a price absent from the sheet',
          source: 'realty-ai:auto_send',
          createdAt,
        },
      ]);
    });

    it('maps every row in a multi-row ledger', async () => {
      repository.listNoShipIncidents.mockResolvedValueOnce([
        {
          id: 'inc-1',
          kind: 'RERA_CLAIM',
          lead_id: null,
          conversation_id: CONVERSATION_ID,
          detail: 'a',
          source: 'manual',
          created_at: new Date(),
        },
        {
          id: 'inc-2',
          kind: 'CROSS_BUYER',
          lead_id: LEAD_ID,
          conversation_id: null,
          detail: 'b',
          source: 'manual',
          created_at: new Date(),
        },
      ]);
      const rows = await service.list(BUSINESS_ID);
      expect(rows.map((r) => r.id)).toEqual(['inc-1', 'inc-2']);
      expect(rows.map((r) => r.leadId)).toEqual([null, LEAD_ID]);
      expect(rows.map((r) => r.conversationId)).toEqual([CONVERSATION_ID, null]);
    });
  });

  describe('guardrail → no-ship mapping', () => {
    it.each([
      ['unverified_price', NoShipKind.UNVERIFIED_PRICE],
      ['stale_availability', NoShipKind.STALE_AVAILABILITY],
      ['opted_out_recipient', NoShipKind.OPTED_OUT_SEND],
      ['rera_claim_unverified', NoShipKind.RERA_CLAIM],
      ['possession_claim_unverified', NoShipKind.RERA_CLAIM],
      ['cross_buyer_disclosure', NoShipKind.CROSS_BUYER],
    ])('maps %s to %s', async (code, kind) => {
      await service.onTurnCompleted(
        baseTurn({ blockingViolations: [code], violations: [code] }),
      );
      expect(repository.createNoShipIncident).toHaveBeenCalledWith(
        expect.objectContaining({ kind }),
      );
    });

    it('records one incident per mapped code on a multi-violation turn', async () => {
      await service.onTurnCompleted(
        baseTurn({
          blockingViolations: [
            'unverified_price',
            'no_negotiation',
            'cross_buyer_disclosure',
          ],
        }),
      );
      expect(repository.createNoShipIncident).toHaveBeenCalledTimes(2);
      expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('treats an absent blockingViolations field as no violations', async () => {
      const turn = baseTurn();
      delete (turn as { blockingViolations?: string[] }).blockingViolations;
      await service.onTurnCompleted(turn);
      expect(repository.createNoShipIncident).not.toHaveBeenCalled();
    });

    it('carries the lead, conversation and intent onto the recorded incident', async () => {
      await service.onTurnCompleted(
        baseTurn({
          blockingViolations: ['stale_availability'],
          conversationId: CONVERSATION_ID,
          intent: 'AVAILABILITY',
        }),
      );
      expect(repository.createNoShipIncident).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: LEAD_ID,
          conversationId: CONVERSATION_ID,
          detail: expect.stringContaining('intent AVAILABILITY'),
          source: 'realty-ai:auto_send',
        }),
      );
    });
  });

  describe('regression watch failure handling', () => {
    it('swallows a ledger write failure so the event listener never breaks the AI loop', async () => {
      repository.createNoShipIncident.mockRejectedValueOnce(
        new Error('append-only rule rejected the write'),
      );
      await expect(
        service.onTurnCompleted(
          baseTurn({ blockingViolations: ['unverified_price'] }),
        ),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('append-only rule rejected the write'),
      );
    });

    it('still records the remaining codes after one write fails', async () => {
      repository.createNoShipIncident.mockRejectedValueOnce(new Error('boom'));
      await service.onTurnCompleted(
        baseTurn({
          blockingViolations: ['unverified_price', 'cross_buyer_disclosure'],
        }),
      );
      expect(repository.createNoShipIncident).toHaveBeenCalledTimes(2);
      expect(repository.createNoShipIncident).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: NoShipKind.CROSS_BUYER }),
      );
    });

    it('stringifies a non-Error rejection instead of logging [object Object]', async () => {
      repository.createNoShipIncident.mockRejectedValueOnce('db offline');
      await service.onTurnCompleted(
        baseTurn({ blockingViolations: ['unverified_price'] }),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('db offline'));
    });
  });
});
