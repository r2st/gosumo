/**
 * Agent-performance module unit tests
 *
 * Coverage:
 *  - getAgentPerformance: 404 for missing/inactive member, merges SLA
 *    compliance from the injected SlaService, falls back to an empty
 *    summary when the member has no activity in range
 *  - listAgentPerformance: maps every summary + attaches SLA data
 *  - date-range validation: 422 above the 365-day cap
 *
 * The repository and SlaService are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { AgentPerformanceService } from './agent-performance.service';
import { AgentPerformanceRepository } from './agent-performance.repository';
import { SlaService } from '../sla/sla.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000050';

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    name: 'Priya Singh',
    email: 'priya@example.com',
    role: 'STAFF',
    assignedConversations: 10,
    resolvedConversations: 8,
    avgFirstResponseSeconds: 120,
    firstResponseSampleSize: 8,
    avgResolutionSeconds: 900,
    resolutionSampleSize: 8,
    csatAverage: 4.5,
    csatResponseCount: 4,
    tasksResolved: 3,
    avgTaskResolutionSeconds: 600,
    ...overrides,
  };
}

describe('AgentPerformanceService', () => {
  let service: AgentPerformanceService;
  let repo: jest.Mocked<AgentPerformanceRepository>;
  let sla: { getBreachCountsByAssignee: jest.Mock };

  beforeEach(async () => {
    repo = {
      findActiveMember: jest.fn(),
      listAgentSummaries: jest.fn(),
    } as unknown as jest.Mocked<AgentPerformanceRepository>;

    sla = { getBreachCountsByAssignee: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentPerformanceService,
        { provide: AgentPerformanceRepository, useValue: repo },
        { provide: SlaService, useValue: sla },
      ],
    }).compile();

    service = module.get(AgentPerformanceService);
  });

  describe('getAgentPerformance', () => {
    it('throws 404 when the member is missing or inactive', async () => {
      repo.findActiveMember.mockResolvedValue(null);
      await expect(service.getAgentPerformance(BUSINESS_ID, MEMBER_ID)).rejects.toThrow(NotFoundException);
    });

    it('merges SLA compliance from the injected SlaService', async () => {
      repo.findActiveMember.mockResolvedValue({
        id: MEMBER_ID,
        name: 'Priya Singh',
        email: 'priya@example.com',
        role: 'STAFF',
      });
      repo.listAgentSummaries.mockResolvedValue([makeSummary()]);
      sla.getBreachCountsByAssignee.mockResolvedValue([
        { assigneeId: MEMBER_ID, breachedCount: 2, totalCount: 10 },
      ]);

      const result = await service.getAgentPerformance(BUSINESS_ID, MEMBER_ID);

      expect(result.slaTargetsTotal).toBe(10);
      expect(result.slaBreachedCount).toBe(2);
      expect(result.slaComplianceRate).toBe(80);
    });

    it('reports 100% compliance when there are no SLA targets in range', async () => {
      repo.findActiveMember.mockResolvedValue({
        id: MEMBER_ID,
        name: 'Priya Singh',
        email: 'priya@example.com',
        role: 'STAFF',
      });
      repo.listAgentSummaries.mockResolvedValue([makeSummary()]);
      sla.getBreachCountsByAssignee.mockResolvedValue([]);

      const result = await service.getAgentPerformance(BUSINESS_ID, MEMBER_ID);
      expect(result.slaComplianceRate).toBe(100);
    });

    it('falls back to an empty summary when the member had no activity in range', async () => {
      repo.findActiveMember.mockResolvedValue({
        id: MEMBER_ID,
        name: 'Priya Singh',
        email: 'priya@example.com',
        role: 'STAFF',
      });
      repo.listAgentSummaries.mockResolvedValue([]); // e.g. inactive filter excluded them from the raw query
      sla.getBreachCountsByAssignee.mockResolvedValue([]);

      const result = await service.getAgentPerformance(BUSINESS_ID, MEMBER_ID);
      expect(result.assignedConversations).toBe(0);
      expect(result.csatAverage).toBeNull();
    });

    it('throws 422 when the requested range exceeds 365 days', async () => {
      repo.findActiveMember.mockResolvedValue({
        id: MEMBER_ID,
        name: 'Priya Singh',
        email: 'priya@example.com',
        role: 'STAFF',
      });
      await expect(
        service.getAgentPerformance(BUSINESS_ID, MEMBER_ID, '2020-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('listAgentPerformance', () => {
    it('maps every summary and attaches SLA data per agent', async () => {
      repo.listAgentSummaries.mockResolvedValue([makeSummary(), makeSummary({ id: 'other', name: 'Raj' })]);
      sla.getBreachCountsByAssignee.mockResolvedValue([
        { assigneeId: MEMBER_ID, breachedCount: 1, totalCount: 5 },
      ]);

      const result = await service.listAgentPerformance(BUSINESS_ID);

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0]?.slaComplianceRate).toBe(80);
      expect(result.agents[1]?.slaComplianceRate).toBe(100); // no SLA data for "other"
    });
  });
});
