import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import { DataExportService } from './data-export.service';
import type { ClientDataRows, DataExportRepository } from './data-export.repository';
import type { AuditLogService } from '../../common/services/audit-log.service';
import {
  EXPORT_FORMAT_VERSION,
  MAX_EXPORT_MESSAGES,
  WITHHELD_FIELDS,
} from './data-export.constants';

const CLIENT = {
  id: 'client-1',
  business_id: 'b1',
  name: 'Asha Iyer',
  email: 'asha@example.in',
  phone: '+919876543210',
  tags: ['vip'],
  profile: { preferredLanguage: 'en' },
  opt_outs: { WHATSAPP: false },
  ltv_score: 5000,
  churn_risk: 0.2,
  engagement_score: 0.9,
  total_orders: 3,
  total_spent: 4500,
  last_interaction_at: new Date('2026-08-01T00:00:00Z'),
  first_seen_at: new Date('2025-01-01T00:00:00Z'),
  deleted_at: null,
} as unknown as ClientDataRows['client'];

const EMPTY_COUNTS = {
  conversations: 0,
  messages: 0,
  orders: 0,
  payments: 0,
  bookings: 0,
  notifications: 0,
  consents: 0,
  channelContacts: 0,
  aiDecisions: 0,
};

function makeHarness(rows: Partial<ClientDataRows> = {}) {
  const collected: ClientDataRows = {
    client: CLIENT,
    channelContacts: [],
    conversations: [],
    messages: [],
    orders: [],
    payments: [],
    bookings: [],
    notifications: [],
    consents: [],
    counts: EMPTY_COUNTS,
    ...rows,
  };

  const repository = {
    findClient: jest.fn().mockResolvedValue(CLIENT),
    findClientByIdentifier: jest.fn().mockResolvedValue(CLIENT),
    collect: jest.fn().mockResolvedValue(collected),
    countAll: jest.fn().mockResolvedValue(collected.counts),
  } as unknown as DataExportRepository;

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogService;

  return {
    service: new DataExportService(repository, audit),
    repository: repository as unknown as Record<string, jest.Mock>,
    audit: audit as unknown as { record: jest.Mock },
  };
}

describe('DataExportService', () => {
  it('returns a versioned bundle for the subject', async () => {
    const h = makeHarness();

    const bundle = await h.service.exportClient('b1', 'client-1');

    expect(bundle.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(bundle.subject).toMatchObject({
      clientId: 'client-1',
      name: 'Asha Iyer',
      phone: '+919876543210',
    });
  });

  it('404s for a client that belongs to another tenant', async () => {
    // The repository scopes by business_id, so a foreign UUID comes back null.
    // 404 rather than 403 on purpose: a 403 would confirm the id exists
    // somewhere, which is an enumeration oracle across the whole platform.
    const h = makeHarness();
    h.repository['findClient']!.mockResolvedValueOnce(null);

    await expect(h.service.exportClient('b1', 'someone-elses')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never asks the repository for data before the client is scoped', async () => {
    const h = makeHarness();
    h.repository['findClient']!.mockResolvedValueOnce(null);

    await h.service.exportClient('b1', 'x').catch(() => undefined);

    expect(h.repository['collect']).not.toHaveBeenCalled();
  });

  describe('what the bundle admits it is missing', () => {
    it('declares the withheld fields', async () => {
      // A withheld field is a decision somebody may have to defend. "We
      // forgot" and "we decided" look identical in a JSON response unless the
      // response says which.
      const h = makeHarness();

      const bundle = await h.service.exportClient('b1', 'client-1');

      expect(bundle.disclosure.withheldFields).toEqual(WITHHELD_FIELDS);
    });

    it('reports truncation when a section hit its cap', async () => {
      const h = makeHarness({
        messages: new Array(MAX_EXPORT_MESSAGES).fill({
          id: 'm',
          conversation_id: 'c',
          content: {},
        }) as unknown as ClientDataRows['messages'],
        counts: { ...EMPTY_COUNTS, messages: MAX_EXPORT_MESSAGES + 1 },
      });

      const bundle = await h.service.exportClient('b1', 'client-1');

      expect(bundle.sections['messages']).toEqual({
        included: MAX_EXPORT_MESSAGES,
        total: MAX_EXPORT_MESSAGES + 1,
        truncated: true,
      });
      expect(bundle.disclosure.truncated).toBe(true);
      expect(bundle.disclosure.notes.join(' ')).toContain('export limit');
    });

    it('does not claim truncation for a section that is merely full', async () => {
      // A section holding exactly its cap is either complete or the tip of
      // something larger, and the caller cannot tell without the true count.
      const h = makeHarness({
        orders: new Array(3).fill({ id: 'o' }) as unknown as ClientDataRows['orders'],
        counts: { ...EMPTY_COUNTS, orders: 3 },
      });

      const bundle = await h.service.exportClient('b1', 'client-1');

      expect(bundle.sections['orders']!.truncated).toBe(false);
      expect(bundle.disclosure.truncated).toBe(false);
    });

    it('counts the AI decisions it excludes, so the gap is visible', async () => {
      const h = makeHarness({ counts: { ...EMPTY_COUNTS, aiDecisions: 12 } });

      const bundle = await h.service.exportClient('b1', 'client-1');

      expect(bundle.disclosure.aiDecisionsExcluded).toBe(12);
      expect(bundle.disclosure.notes.join(' ')).toContain('AI decision');
    });

    it('says nothing about AI decisions when there are none', async () => {
      const h = makeHarness();

      expect((await h.service.exportClient('b1', 'client-1')).disclosure.notes).toEqual([]);
    });
  });

  describe('redaction', () => {
    it('omits the gateway signature and raw provider body from payments', async () => {
      // The signature is a credential and the gateway body carries account
      // identifiers and trace ids that belong to us, not to the customer.
      const h = makeHarness({
        payments: [
          {
            id: 'pay-1',
            order_id: 'o-1',
            status: 'CAPTURED',
            method: 'UPI',
            gateway: 'RAZORPAY',
            amount: 1200,
            currency: 'INR',
            gateway_payment_id: 'pay_ABC',
            gateway_signature: 'sig-secret',
            gateway_response: { account_id: 'acc_internal' },
            created_at: new Date(),
          },
        ] as unknown as ClientDataRows['payments'],
        counts: { ...EMPTY_COUNTS, payments: 1 },
      });

      const serialized = JSON.stringify(
        (await h.service.exportClient('b1', 'client-1')).data.payments,
      );

      expect(serialized).not.toContain('sig-secret');
      expect(serialized).not.toContain('acc_internal');
      // The gateway's payment id stays: it is the reference the customer needs
      // to raise a dispute with their bank.
      expect(serialized).toContain('pay_ABC');
    });

    it("omits the team's internal note on an order", async () => {
      const h = makeHarness({
        orders: [
          {
            id: 'o-1',
            order_number: 'ORD-1',
            status: 'CONFIRMED',
            line_items: [],
            total: 1200,
            currency: 'INR',
            customer_note: 'please ring the bell',
            internal_note: 'difficult customer, ships late',
            placed_at: new Date(),
          },
        ] as unknown as ClientDataRows['orders'],
        counts: { ...EMPTY_COUNTS, orders: 1 },
      });

      const serialized = JSON.stringify(
        (await h.service.exportClient('b1', 'client-1')).data.orders,
      );

      expect(serialized).not.toContain('difficult customer');
      // The customer's own note is theirs and stays.
      expect(serialized).toContain('ring the bell');
    });

    it("omits the conversation's internal note", async () => {
      const h = makeHarness({
        conversations: [
          {
            id: 'c-1',
            channel: 'WHATSAPP',
            status: 'RESOLVED',
            subject: 'Refund query',
            tags: [],
            message_count: 4,
            metadata: { internalNote: 'escalate, threatened to sue' },
            created_at: new Date(),
          },
        ] as unknown as ClientDataRows['conversations'],
        counts: { ...EMPTY_COUNTS, conversations: 1 },
      });

      const serialized = JSON.stringify(
        (await h.service.exportClient('b1', 'client-1')).data.conversations,
      );

      expect(serialized).not.toContain('threatened to sue');
      expect(serialized).toContain('Refund query');
    });

    it('omits the scores the business assigns to the customer', async () => {
      // churn_risk and ltv_score are inferences *about* the person, in the
      // same category as the AI decisions. Disclosing a churn-risk figure to
      // the person it describes is a call for the business, not a default.
      const h = makeHarness();

      const profile = (await h.service.exportClient('b1', 'client-1')).data.profile;

      expect(profile['churnRisk']).toBeUndefined();
      expect(profile['ltvScore']).toBeUndefined();
      expect(profile['engagementScore']).toBeUndefined();
      // What the customer told us, and the preference they set, both stay.
      expect(profile['profile']).toEqual({ preferredLanguage: 'en' });
      expect(profile['optOuts']).toEqual({ WHATSAPP: false });
    });
  });

  describe('the audit trail', () => {
    it('records the export before returning it', async () => {
      const h = makeHarness();

      await h.service.exportClient('b1', 'client-1', {
        teamMemberId: 'tm-1',
        email: 'ops@acme.in',
        ipAddress: '1.2.3.4',
      });

      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: 'b1',
          action: AuditAction.EXPORT,
          resourceType: 'client_data_export',
          resourceId: 'client-1',
          actorType: 'TEAM_MEMBER',
          actorId: 'tm-1',
        }),
      );
    });

    it('records counts, never the exported data', async () => {
      // `audit_logs` is append-only and outlives every retention sweep. It is
      // the one table personal data must not land in.
      const h = makeHarness({
        messages: [
          { id: 'm', conversation_id: 'c', text_content: 'my card number is…' },
        ] as unknown as ClientDataRows['messages'],
        counts: { ...EMPTY_COUNTS, messages: 1 },
      });

      await h.service.exportClient('b1', 'client-1');

      const entry = JSON.stringify(h.audit.record.mock.calls[0]?.[0]);
      expect(entry).not.toContain('card number');
      expect(entry).toContain('sections');
    });

    it('attributes an unattended call to API rather than a team member', async () => {
      const h = makeHarness();

      await h.service.exportClient('b1', 'client-1');

      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'API', actorId: null }),
      );
    });
  });

  describe('summarize', () => {
    it('names the sections that would be truncated', async () => {
      const h = makeHarness();
      h.repository['countAll']!.mockResolvedValueOnce({
        ...EMPTY_COUNTS,
        messages: MAX_EXPORT_MESSAGES + 1,
        orders: 2,
      });

      const summary = await h.service.summarize('b1', 'client-1');

      expect(summary.wouldTruncate).toEqual(['messages']);
    });

    it('names nothing when everything fits', async () => {
      const h = makeHarness();

      expect((await h.service.summarize('b1', 'client-1')).wouldTruncate).toEqual([]);
    });

    it('404s for a client outside the tenant', async () => {
      const h = makeHarness();
      h.repository['findClient']!.mockResolvedValueOnce(null);

      await expect(h.service.summarize('b1', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resolveSubject', () => {
    it('finds the customer by phone', async () => {
      const h = makeHarness();

      expect((await h.service.resolveSubject('b1', { phone: '+919876543210' })).id).toBe(
        'client-1',
      );
    });

    it('rejects an empty identifier instead of searching for nothing', async () => {
      // Otherwise "matches nothing" and "no such customer" come back as the
      // same 404, and the caller cannot tell a typo from a missing record.
      const h = makeHarness();

      await expect(h.service.resolveSubject('b1', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.repository['findClientByIdentifier']).not.toHaveBeenCalled();
    });

    it('404s when nothing matches', async () => {
      const h = makeHarness();
      h.repository['findClientByIdentifier']!.mockResolvedValueOnce(null);

      await expect(
        h.service.resolveSubject('b1', { email: 'nobody@example.in' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
