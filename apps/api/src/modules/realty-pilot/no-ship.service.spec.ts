/**
 * NoShipService unit tests (Phase 8). Repository + emitter mocked. Covers manual
 * recording and the AI-turn regression watch (BLOCK violation + AUTO send).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NoShipKind } from '@gosumo/shared';
import type { RealtyAiTurnCompletedEvent } from '@gosumo/shared';

import { NoShipService } from './no-ship.service';
import { RealtyPilotRepository } from './realty-pilot.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';

function baseTurn(overrides: Partial<RealtyAiTurnCompletedEvent> = {}): RealtyAiTurnCompletedEvent {
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

describe('NoShipService', () => {
  let service: NoShipService;
  let repository: jest.Mocked<RealtyPilotRepository>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyPilotRepository, jest.Mock>> = {
      createNoShipIncident: jest.fn().mockImplementation((d) =>
        Promise.resolve({
          id: 'inc-1',
          kind: d.kind,
          lead_id: d.leadId ?? null,
          conversation_id: d.conversationId ?? null,
          detail: d.detail,
          source: d.source,
          created_at: new Date(),
        }),
      ),
      countNoShipIncidents: jest.fn().mockResolvedValue(0),
    };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoShipService,
        { provide: RealtyPilotRepository, useValue: mockRepo },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get(NoShipService);
    repository = module.get(RealtyPilotRepository) as jest.Mocked<RealtyPilotRepository>;
    emitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  it('records a manual incident and emits the event', async () => {
    const dto = await service.recordFromDto(BUSINESS_ID, {
      kind: NoShipKind.RERA_CLAIM,
      detail: 'quoted an unverified RERA number',
    });
    expect(dto.kind).toBe(NoShipKind.RERA_CLAIM);
    expect(repository.createNoShipIncident).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NoShipKind.RERA_CLAIM, source: 'manual' }),
    );
    expect(emitter.emit).toHaveBeenCalledWith('realty.no_ship.incident', expect.any(Object));
  });

  describe('onTurnCompleted (regression watch)', () => {
    it('records an incident when a BLOCK violation shipped on an AUTO send', async () => {
      await service.onTurnCompleted(
        baseTurn({ blockingViolations: ['unverified_price'], violations: ['unverified_price'] }),
      );
      expect(repository.createNoShipIncident).toHaveBeenCalledWith(
        expect.objectContaining({ kind: NoShipKind.UNVERIFIED_PRICE, source: 'realty-ai:auto_send' }),
      );
    });

    it('ignores non-AUTO route modes (guardrail escalated correctly)', async () => {
      await service.onTurnCompleted(
        baseTurn({ routeMode: 'ESCALATE', blockingViolations: ['unverified_price'] }),
      );
      expect(repository.createNoShipIncident).not.toHaveBeenCalled();
    });

    it('ignores an AUTO send with no blocking violations', async () => {
      await service.onTurnCompleted(baseTurn({ routeMode: 'AUTO', blockingViolations: [] }));
      expect(repository.createNoShipIncident).not.toHaveBeenCalled();
    });

    it('ignores unmapped violation codes', async () => {
      await service.onTurnCompleted(
        baseTurn({ blockingViolations: ['no_negotiation'], violations: ['no_negotiation'] }),
      );
      expect(repository.createNoShipIncident).not.toHaveBeenCalled();
    });
  });
});
