import { BadRequestException, Logger } from '@nestjs/common';
import { normaliseSkills } from '../tenant/tenant.constants';
import { AutoAssignStrategy } from './conversation.constants';

/**
 * Skill-based routing.
 *
 * Two halves, tested separately because they fail differently: the tenant-side
 * skill match (who is even eligible) and the conversation-side load balance
 * (which of the eligible gets it).
 */

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const AGENT_A = '00000000-0000-4000-c000-00000000000a';
const AGENT_B = '00000000-0000-4000-c000-00000000000b';
const AGENT_C = '00000000-0000-4000-c000-00000000000c';

describe('normaliseSkills', () => {
  it('trims, upper-cases and drops blanks', () => {
    expect(normaliseSkills([' hindi ', 'Billing', '', '   '])).toEqual([
      'HINDI',
      'BILLING',
    ]);
  });

  it('de-duplicates case-insensitively while preserving order', () => {
    expect(normaliseSkills(['hindi', 'HINDI', 'billing', 'Hindi'])).toEqual([
      'HINDI',
      'BILLING',
    ]);
  });

  it('ignores non-string entries rather than throwing', () => {
    // The column is free-form and the array arrives from a client; a stray
    // number must not take the routing path down.
    expect(normaliseSkills([42 as never, 'hindi'])).toEqual(['HINDI']);
  });

  it('returns an empty array unchanged', () => {
    expect(normaliseSkills([])).toEqual([]);
  });
});

describe('TenantService.filterAssignableTeamMembersBySkills', () => {
  let repository: {
    findAssignableTeamMembers: jest.Mock;
    findAssignableTeamMembersWithSkills: jest.Mock;
  };
  let service: {
    filterAssignableTeamMembers: (b: string, ids: string[]) => Promise<string[]>;
    filterAssignableTeamMembersBySkills: (
      b: string,
      ids: string[],
      skills: string[],
    ) => Promise<string[]>;
  };

  beforeEach(() => {
    repository = {
      findAssignableTeamMembers: jest.fn(),
      findAssignableTeamMembersWithSkills: jest.fn(),
    };

    // Exercise the real methods against a repository double. Constructing the
    // whole TenantService needs a dozen collaborators none of this touches.
    const { TenantService } = require('../tenant/tenant.service') as {
      TenantService: new (...args: unknown[]) => typeof service;
    };
    service = Object.create(TenantService.prototype);
    (service as unknown as { repository: unknown }).repository = repository;
  });

  it('returns nothing for an empty candidate list without querying', async () => {
    await expect(
      service.filterAssignableTeamMembersBySkills(BUSINESS_ID, [], ['HINDI']),
    ).resolves.toEqual([]);
    expect(repository.findAssignableTeamMembersWithSkills).not.toHaveBeenCalled();
  });

  it('degenerates to plain assignability when no skills are required', async () => {
    repository.findAssignableTeamMembers.mockResolvedValue([{ id: AGENT_A }]);

    await expect(
      service.filterAssignableTeamMembersBySkills(BUSINESS_ID, [AGENT_A], []),
    ).resolves.toEqual([AGENT_A]);
    // The skill query is the more expensive one; it must not run for the
    // unskilled case.
    expect(repository.findAssignableTeamMembersWithSkills).not.toHaveBeenCalled();
  });

  it('keeps only members holding every required skill', async () => {
    // AND, not OR: routing a Hindi billing query to someone who only does
    // billing is the failure this exists to prevent.
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_A, skills: ['HINDI', 'BILLING'] },
      { id: AGENT_B, skills: ['BILLING'] },
      { id: AGENT_C, skills: ['HINDI'] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(
        BUSINESS_ID,
        [AGENT_A, AGENT_B, AGENT_C],
        ['HINDI', 'BILLING'],
      ),
    ).resolves.toEqual([AGENT_A]);
  });

  it('admits a member holding more skills than required', async () => {
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_A, skills: ['HINDI', 'BILLING', 'TECHNICAL'] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(BUSINESS_ID, [AGENT_A], ['HINDI']),
    ).resolves.toEqual([AGENT_A]);
  });

  it('matches case-insensitively on both sides', async () => {
    // The stored value and the requested value are both free-form text written
    // by different clients at different times.
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_A, skills: ['hindi'] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(BUSINESS_ID, [AGENT_A], ['Hindi']),
    ).resolves.toEqual([AGENT_A]);
  });

  it('excludes a member with no skills at all when a skill is required', async () => {
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_A, skills: [] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(BUSINESS_ID, [AGENT_A], ['HINDI']),
    ).resolves.toEqual([]);
  });

  it('preserves the caller’s candidate order', async () => {
    // The load-balancing tie-break reads this order, so the filter must not
    // reorder by whatever the database returned.
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_C, skills: ['HINDI'] },
      { id: AGENT_A, skills: ['HINDI'] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(
        BUSINESS_ID,
        [AGENT_A, AGENT_C],
        ['HINDI'],
      ),
    ).resolves.toEqual([AGENT_A, AGENT_C]);
  });

  it('drops a candidate the tenant query did not return', async () => {
    // Not this tenant's, soft-deleted, or suspended — the skill query already
    // filters those, so anything absent stays absent.
    repository.findAssignableTeamMembersWithSkills.mockResolvedValue([
      { id: AGENT_A, skills: ['HINDI'] },
    ]);

    await expect(
      service.filterAssignableTeamMembersBySkills(
        BUSINESS_ID,
        [AGENT_A, AGENT_B],
        ['HINDI'],
      ),
    ).resolves.toEqual([AGENT_A]);
  });
});

describe('ConversationService.autoAssign — SKILL_BASED', () => {
  let tenantService: {
    filterAssignableTeamMembers: jest.Mock;
    filterAssignableTeamMembersBySkills: jest.Mock;
  };
  let repository: { countActiveByAssignees: jest.Mock };
  let service: {
    autoAssign: (b: string, id: string, o: Record<string, unknown>) => Promise<unknown>;
  };
  let commitAssignment: jest.Mock;

  const CONVERSATION_ID = '00000000-0000-4000-d000-000000000001';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    tenantService = {
      filterAssignableTeamMembers: jest.fn(),
      filterAssignableTeamMembersBySkills: jest.fn(),
    };
    repository = { countActiveByAssignees: jest.fn().mockResolvedValue({}) };
    commitAssignment = jest.fn().mockResolvedValue({ id: CONVERSATION_ID });

    const { ConversationService } = require('./conversation.service') as {
      ConversationService: new (...args: unknown[]) => typeof service;
    };
    service = Object.create(ConversationService.prototype);
    Object.assign(service, {
      tenantService,
      repository,
      commitAssignment,
      // `logger` is an instance field, so `Object.create(prototype)` does not
      // get one — the real constructor is what assigns it.
      logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      requireConversation: jest
        .fn()
        .mockResolvedValue({ id: CONVERSATION_ID, client_id: null, assigned_to: null }),
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const assign = (options: Record<string, unknown>) =>
    service.autoAssign(BUSINESS_ID, CONVERSATION_ID, {
      strategy: AutoAssignStrategy.SKILL_BASED,
      ...options,
    });

  it('routes through the skill filter when skills are required', async () => {
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([AGENT_A]);

    await assign({ candidateAgentIds: [AGENT_A, AGENT_B], requiredSkills: ['HINDI'] });

    expect(tenantService.filterAssignableTeamMembersBySkills).toHaveBeenCalledWith(
      BUSINESS_ID,
      [AGENT_A, AGENT_B],
      ['HINDI'],
    );
    expect(tenantService.filterAssignableTeamMembers).not.toHaveBeenCalled();
  });

  it('behaves as LEAST_BUSY when no skills are required', async () => {
    tenantService.filterAssignableTeamMembers.mockResolvedValue([AGENT_A, AGENT_B]);
    repository.countActiveByAssignees.mockResolvedValue({ [AGENT_A]: 5, [AGENT_B]: 1 });

    await assign({ candidateAgentIds: [AGENT_A, AGENT_B] });

    expect(tenantService.filterAssignableTeamMembersBySkills).not.toHaveBeenCalled();
    expect(commitAssignment.mock.calls[0]![3]).toBe(AGENT_B);
  });

  it('picks the least busy among the qualified, not the least busy overall', async () => {
    // AGENT_B is idle but unqualified, so it must not win. This is the whole
    // point of filtering before balancing.
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([
      AGENT_A,
      AGENT_C,
    ]);
    repository.countActiveByAssignees.mockResolvedValue({
      [AGENT_A]: 7,
      [AGENT_B]: 0,
      [AGENT_C]: 2,
    });

    await assign({
      candidateAgentIds: [AGENT_A, AGENT_B, AGENT_C],
      requiredSkills: ['HINDI'],
    });

    expect(commitAssignment.mock.calls[0]![3]).toBe(AGENT_C);
  });

  it('breaks a load tie on the caller’s candidate order', async () => {
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([
      AGENT_A,
      AGENT_C,
    ]);
    repository.countActiveByAssignees.mockResolvedValue({ [AGENT_A]: 3, [AGENT_C]: 3 });

    await assign({
      candidateAgentIds: [AGENT_A, AGENT_C],
      requiredSkills: ['HINDI'],
    });

    expect(commitAssignment.mock.calls[0]![3]).toBe(AGENT_A);
  });

  it('treats an agent with no recorded load as idle', async () => {
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([
      AGENT_A,
      AGENT_C,
    ]);
    repository.countActiveByAssignees.mockResolvedValue({ [AGENT_A]: 4 });

    await assign({
      candidateAgentIds: [AGENT_A, AGENT_C],
      requiredSkills: ['HINDI'],
    });

    expect(commitAssignment.mock.calls[0]![3]).toBe(AGENT_C);
  });

  it('rejects rather than falling back to an unqualified agent', async () => {
    // Leaving it unassigned, where a human will see it, beats routing it to
    // someone who cannot answer it.
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([]);

    await expect(
      assign({ candidateAgentIds: [AGENT_A], requiredSkills: ['HINDI'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(commitAssignment).not.toHaveBeenCalled();
  });

  it('names the missing skills in the rejection', async () => {
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([]);

    await expect(
      assign({ candidateAgentIds: [AGENT_A], requiredSkills: ['HINDI', 'BILLING'] }),
    ).rejects.toThrow(/HINDI, BILLING/);
  });

  it('still requires a candidate list', async () => {
    await expect(assign({ requiredSkills: ['HINDI'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('records the strategy on the assignment', async () => {
    tenantService.filterAssignableTeamMembersBySkills.mockResolvedValue([AGENT_A]);

    await assign({ candidateAgentIds: [AGENT_A], requiredSkills: ['HINDI'] });

    expect(commitAssignment.mock.calls[0]![5]).toContain('SKILL_BASED');
  });
});
