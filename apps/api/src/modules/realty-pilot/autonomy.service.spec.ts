/**
 * AutonomyService unit tests (Phase 8). Broker service, no-ship service,
 * repository, and the emitter are mocked. Covers evidence gathering, an applied
 * OPEN (writes settings + ledger), a HOLD (no write), and the no-ship CLOSE.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AutonomyDirection, AutonomyLevel } from '@gosumo/shared';

import { AutonomyService } from './autonomy.service';
import { RealtyPilotRepository } from './realty-pilot.repository';
import { RealtyBrokerService } from '../realty-broker/realty-broker.service';
import { NoShipService } from './no-ship.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = '00000000-0000-4000-a000-000000000070';
const NOW = new Date('2026-07-03T00:00:00.000Z');

function settings(overrides: Record<string, unknown> = {}) {
  return {
    autonomy_level: AutonomyLevel.SUGGEST,
    auto_approve_threshold: 90,
    created_at: new Date('2026-06-01T00:00:00.000Z'), // ~32 days before NOW
    ...overrides,
  };
}

describe('AutonomyService', () => {
  let service: AutonomyService;
  let repository: jest.Mocked<RealtyPilotRepository>;
  let broker: jest.Mocked<RealtyBrokerService>;
  let noShip: jest.Mocked<NoShipService>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepo: Partial<Record<keyof RealtyPilotRepository, jest.Mock>> = {
      createAutonomyEvent: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      listAutonomyEvents: jest.fn().mockResolvedValue([]),
    };
    const mockBroker = {
      getSettings: jest.fn(),
      getApprovalStats: jest.fn(),
      getHotAlertActionRate: jest.fn(),
      updateSettings: jest.fn().mockResolvedValue({}),
    };
    const mockNoShip = { count: jest.fn() };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutonomyService,
        { provide: RealtyPilotRepository, useValue: mockRepo },
        { provide: RealtyBrokerService, useValue: mockBroker },
        { provide: NoShipService, useValue: mockNoShip },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get(AutonomyService);
    repository = module.get(RealtyPilotRepository) as jest.Mocked<RealtyPilotRepository>;
    broker = module.get(RealtyBrokerService) as jest.Mocked<RealtyBrokerService>;
    noShip = module.get(NoShipService) as jest.Mocked<NoShipService>;
    emitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  describe('gatherEvidence', () => {
    it('derives days active + approval accuracy', async () => {
      broker.getSettings.mockResolvedValue(settings() as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 40, approvedVerbatim: 30 });
      broker.getHotAlertActionRate.mockResolvedValue(0.8);
      noShip.count.mockResolvedValue(0);

      const ev = await service.gatherEvidence(BUSINESS_ID, NOW);
      expect(ev.daysActive).toBe(32);
      expect(ev.decisionsObserved).toBe(40);
      expect(ev.approvalAccuracy).toBeCloseTo(0.75);
      expect(ev.hotAlertActionRate).toBe(0.8);
    });

    it('treats a null hot-alert rate as 0', async () => {
      broker.getSettings.mockResolvedValue(settings() as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 0, approvedVerbatim: 0 });
      broker.getHotAlertActionRate.mockResolvedValue(null);
      noShip.count.mockResolvedValue(0);
      const ev = await service.gatherEvidence(BUSINESS_ID, NOW);
      expect(ev.hotAlertActionRate).toBe(0);
      expect(ev.approvalAccuracy).toBe(0);
    });
  });

  describe('advance', () => {
    it('applies an OPEN: writes broker settings + an immutable ledger row + emits', async () => {
      broker.getSettings.mockResolvedValue(settings() as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 40, approvedVerbatim: 38 }); // 0.95
      broker.getHotAlertActionRate.mockResolvedValue(0.9);
      noShip.count.mockResolvedValue(0);

      const result = await service.advance(BUSINESS_ID, true, USER_ID, NOW);

      expect(result.recommendation.direction).toBe(AutonomyDirection.OPEN);
      expect(result.applied).toBe(true);
      expect(broker.updateSettings).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ autonomyLevel: AutonomyLevel.ASSISTED, autoApproveThreshold: 90 }),
      );
      expect(repository.createAutonomyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ direction: AutonomyDirection.OPEN, actorType: 'HUMAN' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith('realty.autonomy.changed', expect.any(Object));
    });

    it('does not write on a HOLD (insufficient evidence)', async () => {
      broker.getSettings.mockResolvedValue(settings() as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 0, approvedVerbatim: 0 });
      broker.getHotAlertActionRate.mockResolvedValue(null);
      noShip.count.mockResolvedValue(0);

      const result = await service.advance(BUSINESS_ID, true, USER_ID, NOW);
      expect(result.recommendation.direction).toBe(AutonomyDirection.HOLD);
      expect(result.applied).toBe(false);
      expect(broker.updateSettings).not.toHaveBeenCalled();
      expect(repository.createAutonomyEvent).not.toHaveBeenCalled();
    });

    it('CLOSES the dial to the floor on a no-ship incident', async () => {
      broker.getSettings.mockResolvedValue(
        settings({ autonomy_level: AutonomyLevel.AUTONOMOUS, auto_approve_threshold: 80 }) as never,
      );
      broker.getApprovalStats.mockResolvedValue({ resolved: 500, approvedVerbatim: 480 });
      broker.getHotAlertActionRate.mockResolvedValue(0.9);
      noShip.count.mockResolvedValue(1);

      const result = await service.advance(BUSINESS_ID, true, USER_ID, NOW);
      expect(result.recommendation.direction).toBe(AutonomyDirection.CLOSE);
      expect(broker.updateSettings).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ autonomyLevel: AutonomyLevel.SUGGEST, autoApproveThreshold: 90 }),
      );
    });

    it('preview (apply=false) never writes even on an OPEN', async () => {
      broker.getSettings.mockResolvedValue(settings() as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 40, approvedVerbatim: 38 });
      broker.getHotAlertActionRate.mockResolvedValue(0.9);
      noShip.count.mockResolvedValue(0);

      const result = await service.advance(BUSINESS_ID, false, USER_ID, NOW);
      expect(result.recommendation.direction).toBe(AutonomyDirection.OPEN);
      expect(result.applied).toBe(false);
      expect(broker.updateSettings).not.toHaveBeenCalled();
    });
  });
});
