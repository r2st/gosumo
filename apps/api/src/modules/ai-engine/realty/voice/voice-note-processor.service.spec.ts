/**
 * VoiceNoteProcessorService unit tests.
 *
 * Coverage:
 *  1. transcribeVoiceNote delegates to the STT client.
 *  2. processBuyerVoiceNote feeds the transcript into the realty AI turn.
 *  3. Broker commands route to the right service (pause/resume/assign/price/book)
 *     and every command is recorded to history.
 *  4. Fail-closed: unrecognised transcript, unresolvable lead/project/agent, and
 *     a downstream throw all record without applying a wrong action.
 *
 * All collaborators are mocked; the parsers run for real.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { VoiceNoteProcessorService } from './voice-note-processor.service';
import { TranscriptionService } from './transcription.service';
import { VoiceCommandHistoryService } from './voice-command-history.service';
import { RealtyAiService } from '../realty-ai.service';
import { RealtyLeadsService } from '../../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../../realty-inventory/realty-inventory.service';
import { CadenceEngineService } from '../../../realty-cadence/cadence-engine.service';
import { RealtyVisitsService } from '../../../realty-sitevisits/realty-sitevisits.service';
import { PrismaService } from '../../../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const NOW = new Date(2026, 6, 3, 10, 0, 0);

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead_1',
    name: 'Rahul',
    whatsappPhone: '+919876543210',
    matchedUnitIds: [] as string[],
    ...overrides,
  };
}

describe('VoiceNoteProcessorService', () => {
  let service: VoiceNoteProcessorService;
  let transcription: { transcribe: jest.Mock };
  let realtyAi: { processTurn: jest.Mock };
  let leads: { listLeads: jest.Mock; assignAgent: jest.Mock };
  let inventory: { listProjects: jest.Mock; listUnits: jest.Mock; updateUnit: jest.Mock; getUnit: jest.Mock };
  let cadence: { pauseForLead: jest.Mock; resumeForLead: jest.Mock };
  let visits: { bookVisit: jest.Mock };
  let history: { record: jest.Mock; list: jest.Mock };
  let prisma: { team_members: { findFirst: jest.Mock } };

  beforeEach(async () => {
    transcription = { transcribe: jest.fn().mockResolvedValue('hello world') };
    realtyAi = { processTurn: jest.fn().mockResolvedValue({ routeMode: 'DRAFT' }) };
    leads = {
      listLeads: jest.fn().mockResolvedValue({ data: [lead()] }),
      assignAgent: jest.fn().mockResolvedValue(lead()),
    };
    inventory = {
      listProjects: jest.fn().mockResolvedValue([{ id: 'proj_1', name: 'Serene Heights' }]),
      listUnits: jest.fn().mockResolvedValue([{ id: 'unit_1', config: '2BHK', projectId: 'proj_1' }]),
      updateUnit: jest.fn().mockResolvedValue({ id: 'unit_1' }),
      getUnit: jest.fn().mockResolvedValue({ id: 'unit_1', projectId: 'proj_1' }),
    };
    cadence = {
      pauseForLead: jest.fn().mockResolvedValue(2),
      resumeForLead: jest.fn().mockResolvedValue({ id: 'enr_1' }),
    };
    visits = { bookVisit: jest.fn().mockResolvedValue({ id: 'visit_12345678' }) };
    history = { record: jest.fn().mockResolvedValue(undefined), list: jest.fn() };
    prisma = { team_members: { findFirst: jest.fn().mockResolvedValue({ id: 'agent_1', name: 'Amit' }) } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceNoteProcessorService,
        { provide: TranscriptionService, useValue: transcription },
        { provide: RealtyAiService, useValue: realtyAi },
        { provide: RealtyLeadsService, useValue: leads },
        { provide: RealtyInventoryService, useValue: inventory },
        { provide: CadenceEngineService, useValue: cadence },
        { provide: RealtyVisitsService, useValue: visits },
        { provide: VoiceCommandHistoryService, useValue: history },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(VoiceNoteProcessorService);
  });

  it('transcribes via the STT client', async () => {
    await expect(service.transcribeVoiceNote('whatsapp-media://abc', 'audio/ogg')).resolves.toBe(
      'hello world',
    );
    expect(transcription.transcribe).toHaveBeenCalledWith('whatsapp-media://abc', 'audio/ogg');
  });

  it('feeds a buyer voice note into the realty AI turn', async () => {
    await service.processBuyerVoiceNote(BIZ, 'lead_1', 'I want a 2BHK in Whitefield', {
      conversationId: 'conv_1',
    });
    expect(realtyAi.processTurn).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        leadId: 'lead_1',
        messageText: 'I want a 2BHK in Whitefield',
        conversationId: 'conv_1',
      }),
    );
  });

  // ── Broker command routing ─────────────────────

  it('pauses follow-ups and records the command', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'pause follow-ups for Rahul');
    expect(cadence.pauseForLead).toHaveBeenCalledWith(BIZ, 'lead_1');
    expect(out.status).toBe('executed');
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'executed', command: expect.objectContaining({ kind: 'PAUSE_FOLLOWUPS' }) }),
    );
  });

  it('resumes follow-ups', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'resume follow-ups for Rahul');
    expect(cadence.resumeForLead).toHaveBeenCalledWith(BIZ, 'lead_1');
    expect(out.status).toBe('executed');
  });

  it('assigns a lead to a resolved agent', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'assign Rahul to Amit');
    expect(leads.assignAgent).toHaveBeenCalledWith(BIZ, 'lead_1', 'agent_1');
    expect(out.status).toBe('executed');
  });

  it('leaves assignment unresolved when no agent matches', async () => {
    prisma.team_members.findFirst.mockResolvedValue(null);
    const out = await service.processBrokerVoiceCommand(BIZ, 'assign Rahul to Ghost');
    expect(leads.assignAgent).not.toHaveBeenCalled();
    expect(out.status).toBe('unresolved');
  });

  it('updates a unit price', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'Serene Heights 2BHK now 94L');
    expect(inventory.updateUnit).toHaveBeenCalledWith(BIZ, 'unit_1', {
      allInPricePaise: 94 * 1e5 * 100,
    });
    expect(out.status).toBe('executed');
  });

  it('leaves a price update unresolved when the project is unknown', async () => {
    inventory.listProjects.mockResolvedValue([{ id: 'p', name: 'Other Towers' }]);
    const out = await service.processBrokerVoiceCommand(BIZ, 'Serene Heights 2BHK now 94L');
    expect(inventory.updateUnit).not.toHaveBeenCalled();
    expect(out.status).toBe('unresolved');
  });

  it('books a visit when the lead has a matched unit', async () => {
    leads.listLeads.mockResolvedValue({ data: [lead({ matchedUnitIds: ['unit_1'] })] });
    const out = await service.processBrokerVoiceCommand(BIZ, 'book visit for Rahul tomorrow 5pm', {
      now: NOW,
    });
    expect(visits.bookVisit).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ leadId: 'lead_1', projectId: 'proj_1', unitId: 'unit_1' }),
    );
    expect(out.status).toBe('executed');
  });

  it('leaves a visit unresolved when the lead has no matched unit', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'book visit for Rahul tomorrow 5pm', {
      now: NOW,
    });
    expect(visits.bookVisit).not.toHaveBeenCalled();
    expect(out.status).toBe('unresolved');
  });

  it('records an unrecognised command as not_understood', async () => {
    const out = await service.processBrokerVoiceCommand(BIZ, 'good morning everyone');
    expect(out.status).toBe('not_understood');
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_understood', command: null }),
    );
  });

  it('records a downstream failure as failed', async () => {
    cadence.pauseForLead.mockRejectedValue(new Error('db down'));
    const out = await service.processBrokerVoiceCommand(BIZ, 'pause follow-ups for Rahul');
    expect(out.status).toBe('failed');
    expect(out.detail).toContain('db down');
  });

  it('is unresolved when the lead cannot be found', async () => {
    leads.listLeads.mockResolvedValue({ data: [] });
    const out = await service.processBrokerVoiceCommand(BIZ, 'pause follow-ups for Ghost');
    expect(cadence.pauseForLead).not.toHaveBeenCalled();
    expect(out.status).toBe('unresolved');
  });
});
