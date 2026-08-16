import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { CannedResponseApprovalStatus } from '@gosumo/database';
import { CannedResponseService } from './canned-response.service';
import { CannedResponseRepository } from './canned-response.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const RESPONSE_ID = '00000000-0000-4000-a000-000000000020';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: RESPONSE_ID,
    business_id: BUSINESS_ID,
    title: 'Refund policy',
    shortcut: 'refund-policy',
    content: 'Hi {{customerName}}, your refund of {{amount}} is processed.',
    category: 'billing',
    channel: null,
    tags: [],
    is_active: true,
    usage_count: 0,
    created_by: 'agent-1',
    variables: [
      { name: 'customerName', required: true },
      { name: 'amount', required: true },
    ],
    approval_status: CannedResponseApprovalStatus.DRAFT,
    submitted_by: null,
    submitted_at: null,
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('CannedResponseService — approval workflow', () => {
  let service: CannedResponseService;
  let repo: jest.Mocked<CannedResponseRepository>;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      findByShortcut: jest.fn(),
      findDeletedByShortcut: jest.fn(),
      restore: jest.fn(),
      update: jest.fn().mockImplementation(async (_b, _id, data) => row(toRowShape(data))),
      softDelete: jest.fn(),
      incrementUsage: jest.fn().mockResolvedValue(row({ usage_count: 1 })),
    } as unknown as jest.Mocked<CannedResponseRepository>;

    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CannedResponseService,
        { provide: CannedResponseRepository, useValue: repo },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(CannedResponseService);
  });

  describe('create', () => {
    it('derives the variable list from the body', async () => {
      repo.findByShortcut.mockResolvedValue(null);
      repo.findDeletedByShortcut.mockResolvedValue(null);
      repo.create.mockResolvedValue(row());

      await service.create(BUSINESS_ID, {
        title: 'x',
        shortcut: 'x',
        content: 'Hi {{customerName}}, you owe {{amount}}',
      });

      expect(repo.create).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({
          variables: [
            { name: 'customerName', required: true },
            { name: 'amount', required: true },
          ],
        }),
      );
    });

    it('drops declared metadata for a variable the body does not contain', async () => {
      repo.findByShortcut.mockResolvedValue(null);
      repo.findDeletedByShortcut.mockResolvedValue(null);
      repo.create.mockResolvedValue(row());

      await service.create(BUSINESS_ID, {
        title: 'x',
        shortcut: 'x',
        content: 'Hi {{name}}',
        variables: [{ name: 'name' }, { name: 'ghost', required: false }],
      });

      const created = repo.create.mock.calls[0]![1] as { variables: Array<{ name: string }> };
      expect(created.variables.map((v) => v.name)).toEqual(['name']);
    });
  });

  describe('submitForApproval', () => {
    it('moves a draft to PENDING and records the submitter', async () => {
      repo.findById.mockResolvedValue(row());

      await service.submitForApproval(BUSINESS_ID, RESPONSE_ID, 'agent-1');

      expect(repo.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        RESPONSE_ID,
        expect.objectContaining({
          approvalStatus: CannedResponseApprovalStatus.PENDING,
          submittedBy: 'agent-1',
        }),
      );
    });

    it('allows resubmission after a rejection', async () => {
      // A rejection is feedback to act on, not a dead end.
      repo.findById.mockResolvedValue(
        row({
          approval_status: CannedResponseApprovalStatus.REJECTED,
          review_note: 'too informal',
        }),
      );

      await expect(
        service.submitForApproval(BUSINESS_ID, RESPONSE_ID, 'agent-1'),
      ).resolves.toBeDefined();
    });

    it('clears the previous rejection note on resubmission', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.REJECTED, review_note: 'no' }),
      );

      await service.submitForApproval(BUSINESS_ID, RESPONSE_ID, 'agent-1');

      expect(repo.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        RESPONSE_ID,
        expect.objectContaining({ reviewNote: null, reviewedBy: null }),
      );
    });

    it('refuses to resubmit something already approved', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      await expect(service.submitForApproval(BUSINESS_ID, RESPONSE_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('approve / reject', () => {
    it('approves a pending response and records the reviewer', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.PENDING }),
      );

      await service.approve(BUSINESS_ID, RESPONSE_ID, 'manager-1', 'looks good');

      expect(repo.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        RESPONSE_ID,
        expect.objectContaining({
          approvalStatus: CannedResponseApprovalStatus.APPROVED,
          reviewedBy: 'manager-1',
          reviewNote: 'looks good',
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'canned_response.approved',
        expect.objectContaining({ cannedResponseId: RESPONSE_ID }),
      );
    });

    it('refuses to approve something that was never submitted', async () => {
      repo.findById.mockResolvedValue(row({ approval_status: CannedResponseApprovalStatus.DRAFT }));

      await expect(service.approve(BUSINESS_ID, RESPONSE_ID, 'manager-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('requires a note on a rejection', async () => {
      // A rejection with no reason comes straight back as an identical
      // resubmission.
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.PENDING }),
      );

      await expect(service.reject(BUSINESS_ID, RESPONSE_ID, '   ', 'manager-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('records a rejection with its note', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.PENDING }),
      );

      await service.reject(BUSINESS_ID, RESPONSE_ID, '  too informal  ', 'manager-1');

      expect(repo.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        RESPONSE_ID,
        expect.objectContaining({
          approvalStatus: CannedResponseApprovalStatus.REJECTED,
          reviewNote: 'too informal',
        }),
      );
    });
  });

  describe('editing an approved response', () => {
    it('withdraws the approval when the body changes', async () => {
      // Otherwise the review is a rubber stamp on an id rather than on a
      // message: approve something harmless, then edit it into anything.
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      await service.update(BUSINESS_ID, RESPONSE_ID, { content: 'Something entirely new' });

      expect(repo.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        RESPONSE_ID,
        expect.objectContaining({
          approvalStatus: CannedResponseApprovalStatus.DRAFT,
          reviewedBy: null,
        }),
      );
    });

    it('keeps the approval when only the title changes', async () => {
      // Forcing a re-review for a rename trains reviewers to approve without
      // reading.
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      await service.update(BUSINESS_ID, RESPONSE_ID, { title: 'Refund policy (v2)' });

      const patch = repo.update.mock.calls[0]![2] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('approval_status');
    });

    it('keeps the approval when the content is resubmitted unchanged', async () => {
      const existing = row({ approval_status: CannedResponseApprovalStatus.APPROVED });
      repo.findById.mockResolvedValue(existing);

      await service.update(BUSINESS_ID, RESPONSE_ID, { content: existing.content });

      const patch = repo.update.mock.calls[0]![2] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('approval_status');
    });

    it('re-derives the variables when the body changes', async () => {
      repo.findById.mockResolvedValue(row());

      await service.update(BUSINESS_ID, RESPONSE_ID, { content: 'Only {{one}} now' });

      const patch = repo.update.mock.calls[0]![2] as {
        variables: Array<{ name: string }>;
      };
      expect(patch.variables.map((v) => v.name)).toEqual(['one']);
    });

    it('leaves an unapproved response in its current state', async () => {
      repo.findById.mockResolvedValue(row({ approval_status: CannedResponseApprovalStatus.DRAFT }));

      await service.update(BUSINESS_ID, RESPONSE_ID, { content: 'new body' });

      const patch = repo.update.mock.calls[0]![2] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('approval_status');
    });
  });

  describe('the approval gate', () => {
    it('renders an approved template', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      const result = await service.render(BUSINESS_ID, RESPONSE_ID, {
        customerName: 'Asha',
        amount: '₹1,299',
      });

      expect(result.content).toBe('Hi Asha, your refund of ₹1,299 is processed.');
    });

    it('refuses to render a draft', async () => {
      repo.findById.mockResolvedValue(row({ approval_status: CannedResponseApprovalStatus.DRAFT }));

      await expect(
        service.render(BUSINESS_ID, RESPONSE_ID, { customerName: 'A', amount: '1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to render when a required variable is missing', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      await expect(
        service.render(BUSINESS_ID, RESPONSE_ID, { customerName: 'Asha' }),
      ).rejects.toThrow(/amount/);
    });

    it('blocks recordUsage for an unapproved response', async () => {
      // A client that renders its own body from `content` and then reports
      // usage would otherwise route around the workflow entirely.
      repo.findById.mockResolvedValue(row({ approval_status: CannedResponseApprovalStatus.DRAFT }));

      await expect(service.recordUsage(BUSINESS_ID, RESPONSE_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.incrementUsage).not.toHaveBeenCalled();
    });

    it('allows recordUsage once approved', async () => {
      repo.findById.mockResolvedValue(
        row({ approval_status: CannedResponseApprovalStatus.APPROVED }),
      );

      await expect(service.recordUsage(BUSINESS_ID, RESPONSE_ID)).resolves.toBeDefined();
      expect(repo.incrementUsage).toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('renders a draft and reports what is missing instead of throwing', async () => {
      // Previewing a half-written template is the normal case while writing one.
      repo.findById.mockResolvedValue(row({ approval_status: CannedResponseApprovalStatus.DRAFT }));

      const result = await service.preview(BUSINESS_ID, RESPONSE_ID, { customerName: 'Asha' });

      expect(result.missingRequired).toEqual(['amount']);
      expect(result.content).toContain('Asha');
    });
  });
});

/** Map the repository's camelCase patch back onto row columns for the stub. */
function toRowShape(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data['approvalStatus']) out['approval_status'] = data['approvalStatus'];
  if (data['approval_status']) out['approval_status'] = data['approval_status'];
  if (data['content']) out['content'] = data['content'];
  return out;
}
