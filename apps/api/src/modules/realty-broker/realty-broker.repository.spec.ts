/**
 * RealtyBrokerRepository unit tests.
 *
 * The service specs mock this repository out, so its filter-building and
 * aggregate-folding logic had never run. Three things here are load-bearing:
 *
 *  - the optional filters on `listApprovals` / `listAlerts` / `findHotAlerts`,
 *    where an absent filter must widen the query and a present one must narrow
 *    it — and `unreadOnly: false` must widen, not narrow;
 *  - `approvalStatusCounts` and `countControlByOwner`, which fold Prisma
 *    groupBy rows into the evidence the autonomy dial reads. An owner the fold
 *    does not recognise must not corrupt the counts;
 *  - `upsertControl`, whose update branch deliberately omits `lead_id` when the
 *    caller did not mention it, so releasing a takeover cannot orphan the row
 *    from its lead.
 */
import { Test } from '@nestjs/testing';
import { RealtyBrokerRepository } from './realty-broker.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const LEAD = '00000000-0000-4000-a000-0000000000e1';
const CONVO = '00000000-0000-4000-a000-0000000000c1';

describe('RealtyBrokerRepository', () => {
  let repository: RealtyBrokerRepository;
  let prisma: {
    realty_approvals: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    realty_broker_alerts: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    realty_account_settings: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    realty_conversation_control: { findFirst: jest.Mock; upsert: jest.Mock; groupBy: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      realty_approvals: {
        create: jest.fn().mockResolvedValue({ id: 'a1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'a1' }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      realty_broker_alerts: {
        create: jest.fn().mockResolvedValue({ id: 'al1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'al1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        count: jest.fn().mockResolvedValue(0),
      },
      realty_account_settings: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ business_id: BIZ }),
        update: jest.fn().mockResolvedValue({ business_id: BIZ }),
      },
      realty_conversation_control: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'ctl1' }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module = await Test.createTestingModule({
      providers: [RealtyBrokerRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(RealtyBrokerRepository);
  });

  const approvalWhere = () =>
    prisma.realty_approvals.findMany.mock.calls[0][0].where as Record<string, unknown>;
  const alertWhere = () =>
    prisma.realty_broker_alerts.findMany.mock.calls[0][0].where as Record<string, unknown>;

  describe('createApproval', () => {
    it('nulls the optional links and opens the row as PENDING', async () => {
      await repository.createApproval({
        businessId: BIZ,
        leadId: LEAD,
        draftText: 'Hi there',
        confidence: 82,
      });

      expect(prisma.realty_approvals.create).toHaveBeenCalledWith({
        data: {
          business_id: BIZ,
          lead_id: LEAD,
          conversation_id: null,
          draft_text: 'Hi there',
          confidence: 82,
          intent: null,
          status: 'PENDING',
        },
      });
    });

    it('keeps the optional links when supplied', async () => {
      await repository.createApproval({
        businessId: BIZ,
        leadId: LEAD,
        conversationId: CONVO,
        draftText: 'Hi there',
        confidence: 82,
        intent: 'SITE_VISIT',
      });

      expect(prisma.realty_approvals.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ conversation_id: CONVO, intent: 'SITE_VISIT' }),
      });
    });
  });

  describe('listApprovals', () => {
    it('lists the tenant’s live approvals when no filter is given', async () => {
      await repository.listApprovals(BIZ);

      expect(approvalWhere()).toEqual({ business_id: BIZ, deleted_at: null });
    });

    it('narrows by status alone', async () => {
      await repository.listApprovals(BIZ, { status: 'PENDING' });

      expect(approvalWhere()).toEqual({
        business_id: BIZ,
        deleted_at: null,
        status: 'PENDING',
      });
    });

    it('narrows by lead alone', async () => {
      await repository.listApprovals(BIZ, { leadId: LEAD });

      expect(approvalWhere()).toEqual({
        business_id: BIZ,
        deleted_at: null,
        lead_id: LEAD,
      });
    });

    it('narrows by status and lead together', async () => {
      await repository.listApprovals(BIZ, { status: 'APPROVED', leadId: LEAD });

      expect(approvalWhere()).toEqual({
        business_id: BIZ,
        deleted_at: null,
        status: 'APPROVED',
        lead_id: LEAD,
      });
    });

    it('bounds the result set and surfaces pending work first', async () => {
      await repository.listApprovals(BIZ);

      expect(prisma.realty_approvals.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
          take: 200,
        }),
      );
    });
  });

  describe('approvalStatusCounts', () => {
    it('is an empty map when the tenant has no approvals', async () => {
      await expect(repository.approvalStatusCounts(BIZ)).resolves.toEqual({});
    });

    it('folds every group row into a status→count map', async () => {
      prisma.realty_approvals.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { _all: 4 } },
        { status: 'APPROVED', _count: { _all: 11 } },
        { status: 'REJECTED', _count: { _all: 2 } },
      ]);

      await expect(repository.approvalStatusCounts(BIZ)).resolves.toEqual({
        PENDING: 4,
        APPROVED: 11,
        REJECTED: 2,
      });
    });

    it('excludes soft-deleted approvals from the aggregate', async () => {
      await repository.approvalStatusCounts(BIZ);

      expect(prisma.realty_approvals.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { business_id: BIZ, deleted_at: null } }),
      );
    });
  });

  describe('findHotAlerts', () => {
    it('reads the whole history when no lower bound is given', async () => {
      await repository.findHotAlerts(BIZ);

      expect(alertWhere()).toEqual({ business_id: BIZ, type: 'HOT_LEAD' });
    });

    it('bounds the window when a since date is given', async () => {
      const since = new Date('2026-07-01T00:00:00.000Z');

      await repository.findHotAlerts(BIZ, since);

      expect(alertWhere()).toEqual({
        business_id: BIZ,
        type: 'HOT_LEAD',
        created_at: { gte: since },
      });
    });

    it('selects only the two timestamps the action-rate KPI needs', async () => {
      await repository.findHotAlerts(BIZ);

      expect(prisma.realty_broker_alerts.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { created_at: true, read_at: true },
          take: 1000,
        }),
      );
    });
  });

  describe('listAlerts', () => {
    it('lists everything for the tenant when unfiltered', async () => {
      await repository.listAlerts(BIZ);

      expect(alertWhere()).toEqual({ business_id: BIZ });
    });

    it('narrows to unread when asked', async () => {
      await repository.listAlerts(BIZ, { unreadOnly: true });

      expect(alertWhere()).toEqual({ business_id: BIZ, is_read: false });
    });

    it('does not narrow when unreadOnly is explicitly false', async () => {
      await repository.listAlerts(BIZ, { unreadOnly: false });

      expect(alertWhere()).toEqual({ business_id: BIZ });
    });

    it('narrows by type', async () => {
      await repository.listAlerts(BIZ, { type: 'HOT_LEAD' });

      expect(alertWhere()).toEqual({ business_id: BIZ, type: 'HOT_LEAD' });
    });

    it('combines both filters', async () => {
      await repository.listAlerts(BIZ, { unreadOnly: true, type: 'HOT_LEAD' });

      expect(alertWhere()).toEqual({ business_id: BIZ, is_read: false, type: 'HOT_LEAD' });
    });
  });

  describe('alert reads', () => {
    it('stamps read_at when marking one alert read', async () => {
      await repository.markAlertRead(BIZ, 'al1');

      const call = prisma.realty_broker_alerts.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'al1', business_id: BIZ });
      expect(call.data.is_read).toBe(true);
      expect(call.data.read_at).toBeInstanceOf(Date);
    });

    it('returns how many alerts a mark-all actually touched', async () => {
      await expect(repository.markAllAlertsRead(BIZ)).resolves.toBe(3);

      expect(prisma.realty_broker_alerts.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { business_id: BIZ, is_read: false } }),
      );
    });

    it('nulls the optional alert fields on create', async () => {
      await repository.createAlert({ businessId: BIZ, type: 'HOT_LEAD', title: 'Hot lead' });

      expect(prisma.realty_broker_alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ lead_id: null, body: null, payload: {} }),
      });
    });

    it('keeps the optional alert fields when supplied', async () => {
      await repository.createAlert({
        businessId: BIZ,
        type: 'HOT_LEAD',
        title: 'Hot lead',
        leadId: LEAD,
        body: 'Asked for a site visit',
        payload: { score: 91 },
      });

      expect(prisma.realty_broker_alerts.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          lead_id: LEAD,
          body: 'Asked for a site visit',
          payload: { score: 91 },
        }),
      });
    });
  });

  describe('upsertControl', () => {
    const createData = () => prisma.realty_conversation_control.upsert.mock.calls[0][0].create;
    const updateData = () => prisma.realty_conversation_control.upsert.mock.calls[0][0].update;

    it('keys the upsert on the tenant+conversation composite', async () => {
      await repository.upsertControl(BIZ, CONVO, { owner: 'AI' });

      expect(prisma.realty_conversation_control.upsert.mock.calls[0][0].where).toEqual({
        business_id_conversation_id: { business_id: BIZ, conversation_id: CONVO },
      });
    });

    it('nulls every optional column on the create branch', async () => {
      await repository.upsertControl(BIZ, CONVO, { owner: 'AI' });

      expect(createData()).toEqual({
        business_id: BIZ,
        conversation_id: CONVO,
        lead_id: null,
        owner: 'AI',
        taken_over_by: null,
        taken_over_at: null,
        released_at: null,
      });
    });

    it('leaves lead_id untouched on update when the caller did not mention it', async () => {
      // Releasing a takeover passes only the owner; writing lead_id: null here
      // would orphan an existing control row from its lead.
      await repository.upsertControl(BIZ, CONVO, { owner: 'AI' });

      expect(updateData()).not.toHaveProperty('lead_id');
    });

    it('writes lead_id on update when the caller supplied one', async () => {
      await repository.upsertControl(BIZ, CONVO, { owner: 'HUMAN', leadId: LEAD });

      expect(updateData()).toMatchObject({ owner: 'HUMAN', lead_id: LEAD });
    });

    it('writes an explicit null lead_id when the caller clears it', async () => {
      await repository.upsertControl(BIZ, CONVO, { owner: 'AI', leadId: null });

      expect(updateData()).toMatchObject({ lead_id: null });
    });

    it('carries the takeover bookkeeping through both branches', async () => {
      const takenOverAt = new Date('2026-07-01T10:00:00.000Z');

      await repository.upsertControl(BIZ, CONVO, {
        owner: 'HUMAN',
        takenOverBy: 'user-1',
        takenOverAt,
      });

      expect(createData()).toMatchObject({ taken_over_by: 'user-1', taken_over_at: takenOverAt });
      expect(updateData()).toMatchObject({ taken_over_by: 'user-1', taken_over_at: takenOverAt });
    });
  });

  describe('countControlByOwner', () => {
    it('is zero on both sides when nothing is tracked', async () => {
      await expect(repository.countControlByOwner(BIZ)).resolves.toEqual({ ai: 0, human: 0 });
    });

    it('folds the AI and HUMAN groups onto their own counters', async () => {
      prisma.realty_conversation_control.groupBy.mockResolvedValue([
        { owner: 'AI', _count: { _all: 17 } },
        { owner: 'HUMAN', _count: { _all: 5 } },
      ]);

      await expect(repository.countControlByOwner(BIZ)).resolves.toEqual({ ai: 17, human: 5 });
    });

    it('leaves the missing side at zero when only one owner is present', async () => {
      prisma.realty_conversation_control.groupBy.mockResolvedValue([
        { owner: 'HUMAN', _count: { _all: 5 } },
      ]);

      await expect(repository.countControlByOwner(BIZ)).resolves.toEqual({ ai: 0, human: 5 });
    });

    it('ignores an owner value it does not recognise', async () => {
      prisma.realty_conversation_control.groupBy.mockResolvedValue([
        { owner: 'AI', _count: { _all: 2 } },
        { owner: 'SOMETHING_NEW', _count: { _all: 99 } },
      ]);

      await expect(repository.countControlByOwner(BIZ)).resolves.toEqual({ ai: 2, human: 0 });
    });
  });

  describe('tenant scoping', () => {
    it('scopes the approval and alert point reads', async () => {
      await repository.findApprovalById(BIZ, 'a1');
      await repository.findAlertById(BIZ, 'al1');

      expect(prisma.realty_approvals.findFirst).toHaveBeenCalledWith({
        where: { id: 'a1', business_id: BIZ, deleted_at: null },
      });
      expect(prisma.realty_broker_alerts.findFirst).toHaveBeenCalledWith({
        where: { id: 'al1', business_id: BIZ },
      });
    });

    it('scopes the unread and status counts', async () => {
      await repository.countUnreadAlerts(BIZ);
      await repository.countApprovals(BIZ, 'PENDING');

      expect(prisma.realty_broker_alerts.count).toHaveBeenCalledWith({
        where: { business_id: BIZ, is_read: false },
      });
      expect(prisma.realty_approvals.count).toHaveBeenCalledWith({
        where: { business_id: BIZ, status: 'PENDING', deleted_at: null },
      });
    });

    it('scopes the settings row to the tenant', async () => {
      await repository.findSettings(BIZ);
      await repository.createSettings(BIZ);
      await repository.updateSettings(BIZ, { autonomy_level: 'ASSISTED' });

      expect(prisma.realty_account_settings.findUnique).toHaveBeenCalledWith({
        where: { business_id: BIZ },
      });
      expect(prisma.realty_account_settings.create).toHaveBeenCalledWith({
        data: { business_id: BIZ },
      });
      expect(prisma.realty_account_settings.update).toHaveBeenCalledWith({
        where: { business_id: BIZ },
        data: { autonomy_level: 'ASSISTED' },
      });
    });

    it('scopes the control point read', async () => {
      await repository.findControl(BIZ, CONVO);

      expect(prisma.realty_conversation_control.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, conversation_id: CONVO },
      });
    });
  });
});
