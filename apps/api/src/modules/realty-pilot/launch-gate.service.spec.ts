/**
 * LaunchGateService unit tests (Phase 8, blueprint §24). The leads, visits, and
 * broker services + no-ship service are mocked; verifies metric assembly from
 * the pipeline board / visit stats and the overall GO / NOT_READY verdict.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LaunchGateStatus, LaunchCheckStatus, LeadStage } from '@gosumo/shared';

import { LaunchGateService } from './launch-gate.service';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { RealtyVisitsService } from '../realty-sitevisits/realty-sitevisits.service';
import { RealtyBrokerService } from '../realty-broker/realty-broker.service';
import { NoShipService } from './no-ship.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

/** A board totalling 100 leads: 20 NEW, 20 CONTACTED, 60 qualified-or-beyond. */
function board() {
  return [
    { stage: LeadStage.NEW, count: 20 },
    { stage: LeadStage.CONTACTED, count: 20 },
    { stage: LeadStage.QUALIFIED, count: 30 },
    { stage: LeadStage.VISIT_BOOKED, count: 10 },
    { stage: LeadStage.VISITED, count: 10 },
    { stage: LeadStage.NEGOTIATING, count: 5 },
    { stage: LeadStage.CLOSED_WON, count: 5 },
  ];
}

describe('LaunchGateService', () => {
  let service: LaunchGateService;
  let leads: jest.Mocked<RealtyLeadsService>;
  let visits: jest.Mocked<RealtyVisitsService>;
  let broker: jest.Mocked<RealtyBrokerService>;
  let noShip: jest.Mocked<NoShipService>;

  beforeEach(async () => {
    const mockLeads = { getBoard: jest.fn().mockResolvedValue(board()) };
    const mockVisits = { getVisitStats: jest.fn().mockResolvedValue({ total: 12, completed: 7, noShow: 3 }) };
    const mockBroker = {
      getAiHandledPct: jest.fn().mockResolvedValue(80),
      getHotAlertActionRate: jest.fn().mockResolvedValue(0.75),
    };
    const mockNoShip = {
      count: jest.fn().mockResolvedValue(0),
      countByKind: jest.fn().mockResolvedValue({}),
    };
    const mockEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LaunchGateService,
        { provide: RealtyLeadsService, useValue: mockLeads },
        { provide: RealtyVisitsService, useValue: mockVisits },
        { provide: RealtyBrokerService, useValue: mockBroker },
        { provide: NoShipService, useValue: mockNoShip },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get(LaunchGateService);
    leads = module.get(RealtyLeadsService) as jest.Mocked<RealtyLeadsService>;
    visits = module.get(RealtyVisitsService) as jest.Mocked<RealtyVisitsService>;
    broker = module.get(RealtyBrokerService) as jest.Mocked<RealtyBrokerService>;
    noShip = module.get(NoShipService) as jest.Mocked<NoShipService>;
    jest.clearAllMocks();
  });

  it('assembles KPIs from the pipeline board + visit stats', async () => {
    const metrics = await service.assembleMetrics(BUSINESS_ID, {});
    expect(metrics.totalLeads).toBe(100);
    expect(metrics.qualificationRatePct).toBe(60); // 60/100
    expect(metrics.engagementRatePct).toBe(80); // (100-20)/100
    expect(metrics.visitsPer100Leads).toBe(12); // 12/100*100
    expect(metrics.showUpRatePct).toBe(70); // 7/(7+3)
    expect(metrics.aiAutonomyPct).toBe(80);
    expect(metrics.hotAlertActionRatePct).toBe(75);
  });

  it('is NOT_READY without a supplied response-P95', async () => {
    const report = await service.evaluate(BUSINESS_ID);
    expect(report.status).toBe(LaunchGateStatus.NOT_READY);
    expect(report.kpiChecks.find((c) => c.key === 'response_p95')?.status).toBe(
      LaunchCheckStatus.INSUFFICIENT_DATA,
    );
  });

  it('is GO once a passing response-P95 is supplied and no incidents exist', async () => {
    const report = await service.evaluate(BUSINESS_ID, { responseP95Seconds: 45 });
    expect(report.status).toBe(LaunchGateStatus.GO);
  });

  it('is NO_GO when a no-ship incident is present', async () => {
    noShip.count.mockResolvedValue(1);
    noShip.countByKind.mockResolvedValue({ OPTED_OUT_SEND: 1 });
    const report = await service.evaluate(BUSINESS_ID, { responseP95Seconds: 45 });
    expect(report.status).toBe(LaunchGateStatus.NO_GO);
  });

  it('marks divide-by-zero KPIs INSUFFICIENT_DATA when there are no leads', async () => {
    leads.getBoard.mockResolvedValue([{ stage: LeadStage.NEW, count: 0 }]);
    visits.getVisitStats.mockResolvedValue({ total: 0, completed: 0, noShow: 0 });
    broker.getHotAlertActionRate.mockResolvedValue(null);
    const metrics = await service.assembleMetrics(BUSINESS_ID, {});
    expect(metrics.qualificationRatePct).toBeNull();
    expect(metrics.showUpRatePct).toBeNull();
    expect(metrics.visitsPer100Leads).toBeNull();
  });
});
