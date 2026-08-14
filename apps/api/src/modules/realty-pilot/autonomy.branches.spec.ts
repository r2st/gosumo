/**
 * AutonomyService — the branches `autonomy.service.spec.ts` does not reach.
 *
 * That file pins the ladder behaviour with an injected clock and a human actor,
 * which leaves three groups uncovered, all of which are what production hits:
 *
 *  - the `now = new Date()` defaults, used by every real caller (the controller
 *    passes no clock);
 *  - the AI-actor path, taken whenever the dial advances from a scheduled job
 *    rather than a person clicking "apply";
 *  - `listEvents`/`map`, including the `evidence ?? {}` fallback for a ledger
 *    row written before evidence was captured.
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

/** Old enough, and clean enough, that the ladder wants to open a rung. */
function healthySettings(overrides: Record<string, unknown> = {}) {
  return {
    autonomy_level: AutonomyLevel.SUGGEST,
    auto_approve_threshold: 90,
    created_at: new Date(Date.now() - 60 * 86_400_000),
    ...overrides,
  };
}

describe('AutonomyService — default clock, AI actor, and the event ledger', () => {
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
      getSettings: jest.fn().mockResolvedValue(healthySettings()),
      getApprovalStats: jest.fn().mockResolvedValue({ resolved: 200, approvedVerbatim: 190 }),
      getHotAlertActionRate: jest.fn().mockResolvedValue(0.9),
      updateSettings: jest.fn().mockResolvedValue({}),
    };
    const mockNoShip = { count: jest.fn().mockResolvedValue(0) };
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
  });

  describe('the default clock', () => {
    it('gathers evidence against wall-clock time when no clock is injected', async () => {
      const ev = await service.gatherEvidence(BUSINESS_ID);

      // created_at is 60 days back, so daysActive lands on 59 or 60 depending
      // on where the wall clock falls inside the day.
      expect(ev.daysActive).toBeGreaterThanOrEqual(59);
      expect(ev.decisionsObserved).toBe(200);
      expect(ev.approvalAccuracy).toBeCloseTo(0.95);
    });

    it('never reports negative days for a business created in the future', async () => {
      broker.getSettings.mockResolvedValue(
        healthySettings({ created_at: new Date(Date.now() + 86_400_000) }) as never,
      );

      const ev = await service.gatherEvidence(BUSINESS_ID);

      expect(ev.daysActive).toBe(0);
    });

    it('scores approval accuracy as zero rather than NaN when nothing has resolved', async () => {
      broker.getApprovalStats.mockResolvedValue({ resolved: 0, approvedVerbatim: 0 } as never);

      const ev = await service.gatherEvidence(BUSINESS_ID);

      expect(ev.approvalAccuracy).toBe(0);
      expect(Number.isNaN(ev.approvalAccuracy)).toBe(false);
    });

    it('treats an absent hot-alert action rate as zero', async () => {
      broker.getHotAlertActionRate.mockResolvedValue(null as never);

      const ev = await service.gatherEvidence(BUSINESS_ID);

      expect(ev.hotAlertActionRate).toBe(0);
    });

    it('evaluates against wall-clock time when no clock is injected', async () => {
      const result = await service.evaluate(BUSINESS_ID);

      expect(result.current).toEqual({
        level: AutonomyLevel.SUGGEST,
        threshold: 90,
      });
      expect(result.recommendation.direction).toBeDefined();
    });

    it('advances against wall-clock time when no clock is injected', async () => {
      const result = await service.advance(BUSINESS_ID, true, USER_ID);

      expect(result.recommendation).toBeDefined();
      expect(typeof result.applied).toBe('boolean');
    });
  });

  describe('actor attribution', () => {
    it('records an unattended advance as an AI actor', async () => {
      const result = await service.advance(BUSINESS_ID, true);

      // The evidence above is clean and mature, so the ladder opens a rung.
      expect(result.applied).toBe(true);
      expect(repository.createAutonomyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'AI', actorId: null }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.autonomy.changed',
        expect.objectContaining({ actorType: 'AI' }),
      );
    });

    it('records an operator-triggered advance as a human actor carrying their id', async () => {
      const result = await service.advance(BUSINESS_ID, true, USER_ID);

      expect(result.applied).toBe(true);
      expect(repository.createAutonomyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'HUMAN', actorId: USER_ID }),
      );
    });

    it('writes nothing on a HOLD even when the caller asked to apply', async () => {
      // A brand-new business has no evidence, so the ladder holds.
      broker.getSettings.mockResolvedValue(healthySettings({ created_at: new Date() }) as never);
      broker.getApprovalStats.mockResolvedValue({ resolved: 0, approvedVerbatim: 0 } as never);

      const result = await service.advance(BUSINESS_ID, true, USER_ID);

      expect(result.recommendation.direction).toBe(AutonomyDirection.HOLD);
      expect(result.applied).toBe(false);
      expect(result.eventId).toBeNull();
      expect(broker.updateSettings).not.toHaveBeenCalled();
      expect(repository.createAutonomyEvent).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('closes the dial and still attributes the actor when a no-ship incident exists', async () => {
      noShip.count.mockResolvedValue(1 as never);
      broker.getSettings.mockResolvedValue(
        healthySettings({ autonomy_level: AutonomyLevel.AUTONOMOUS }) as never,
      );

      const result = await service.advance(BUSINESS_ID, true);

      expect(result.recommendation.direction).toBe(AutonomyDirection.CLOSE);
      expect(result.applied).toBe(true);
      expect(repository.createAutonomyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'AI' }),
      );
    });
  });

  describe('listEvents', () => {
    it('returns an empty list when the ledger has no rows', async () => {
      await expect(service.listEvents(BUSINESS_ID)).resolves.toEqual([]);
    });

    it('maps a ledger row onto the DTO', async () => {
      const createdAt = new Date('2026-07-01T00:00:00.000Z');
      repository.listAutonomyEvents.mockResolvedValue([
        {
          id: 'evt-1',
          direction: 'OPEN',
          from_level: 'SUGGEST',
          to_level: 'DRAFT',
          from_threshold: 90,
          to_threshold: 85,
          reason: 'accuracy sustained',
          actor_type: 'AI',
          actor_id: null,
          evidence: { daysActive: 60 },
          created_at: createdAt,
        },
      ] as never);

      const [dto] = await service.listEvents(BUSINESS_ID);

      expect(dto).toEqual({
        id: 'evt-1',
        direction: 'OPEN',
        fromLevel: 'SUGGEST',
        toLevel: 'DRAFT',
        fromThreshold: 90,
        toThreshold: 85,
        reason: 'accuracy sustained',
        actorType: 'AI',
        actorId: null,
        evidence: { daysActive: 60 },
        createdAt,
      });
    });

    it('falls back to an empty evidence object for a row that captured none', async () => {
      repository.listAutonomyEvents.mockResolvedValue([
        {
          id: 'evt-2',
          direction: 'CLOSE',
          from_level: 'AUTO',
          to_level: 'DRAFT',
          from_threshold: 80,
          to_threshold: 90,
          reason: 'no-ship incident',
          actor_type: 'HUMAN',
          actor_id: USER_ID,
          evidence: null,
          created_at: new Date(),
        },
      ] as never);

      const [dto] = await service.listEvents(BUSINESS_ID);

      expect(dto?.evidence).toEqual({});
      expect(dto?.actorId).toBe(USER_ID);
    });

    it('maps every row, not just the first', async () => {
      const row = (id: string) => ({
        id,
        direction: 'OPEN',
        from_level: 'SUGGEST',
        to_level: 'DRAFT',
        from_threshold: 90,
        to_threshold: 85,
        reason: 'r',
        actor_type: 'AI',
        actor_id: null,
        evidence: {},
        created_at: new Date(),
      });
      repository.listAutonomyEvents.mockResolvedValue([row('a'), row('b'), row('c')] as never);

      const dtos = await service.listEvents(BUSINESS_ID);

      expect(dtos.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
