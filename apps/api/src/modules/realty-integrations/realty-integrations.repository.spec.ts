/**
 * RealtyIntegrationsRepository unit tests.
 *
 * Two tables with very different risk profiles live behind this repository.
 *
 * `realty_integration_connections` holds OAuth credentials for outbound
 * integrations. Its upsert is the write that decides *whose* Google Sheet a
 * tenant's leads get pushed into, so the branches that matter are the ones
 * distinguishing "the caller did not mention this field" from "the caller set
 * it to null" — a credential blob or an `external_ref` wiped by an unrelated
 * status update is a broken integration, and one overwritten with someone
 * else's is worse.
 *
 * `realty_eoi_requests` holds token-money payment intents. `updateEoi` carries
 * eleven optional fields including `paid_at` and `gateway_payment_id`, and the
 * webhook that sets them is `@Public()`. Its tenant guard is the `updateMany`
 * scoped by `business_id`, asserted here alongside the deliberate exception:
 * `findAnyEoiByPaymentLink` is unscoped by design, because on the webhook path
 * the tenant is not known until the EOI is found.
 *
 * PrismaService is mocked; the assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { RealtyIntegrationProvider } from '@prisma/client';
import { ResourceNotFoundError } from '@gosumo/shared';

import { RealtyIntegrationsRepository } from './realty-integrations.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONNECTION_ID = '00000000-0000-4000-b000-000000000001';
const EOI_ID = '00000000-0000-4000-c000-000000000001';
const LEAD_ID = '00000000-0000-4000-d000-000000000001';
const UNIT_ID = '00000000-0000-4000-e000-000000000001';
const USER_ID = '00000000-0000-4000-f000-000000000001';

const PROVIDER = RealtyIntegrationProvider.GOOGLE_SHEETS;

interface Table {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
}

function makeTable(row: Record<string, unknown>): Table {
  return {
    create: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue(row),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  };
}

describe('RealtyIntegrationsRepository', () => {
  let repository: RealtyIntegrationsRepository;
  let prisma: {
    realty_integration_connections: Table;
    realty_eoi_requests: Table;
  };

  beforeEach(async () => {
    prisma = {
      realty_integration_connections: makeTable({ id: CONNECTION_ID }),
      realty_eoi_requests: makeTable({ id: EOI_ID }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyIntegrationsRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(RealtyIntegrationsRepository);
  });

  const argsOf = (fn: jest.Mock, call = 0): { where?: Record<string, unknown>; data?: Record<string, unknown> } =>
    fn.mock.calls[call]?.[0] as { where?: Record<string, unknown>; data?: Record<string, unknown> };

  // ─────────────────────────────────────────────
  // Connections — reads
  // ─────────────────────────────────────────────

  describe('connection lookups', () => {
    it('scopes findConnection to the tenant and skips disconnected rows', async () => {
      await repository.findConnection(BUSINESS_ID, PROVIDER);

      expect(argsOf(prisma.realty_integration_connections.findFirst).where).toEqual({
        business_id: BUSINESS_ID,
        provider: PROVIDER,
        deleted_at: null,
      });
    });

    it('scopes listConnections to the tenant', async () => {
      await repository.listConnections(BUSINESS_ID);

      expect(argsOf(prisma.realty_integration_connections.findMany).where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });

    it('crosses tenants only for the nightly sweep, and only for live connections', async () => {
      // `listConnectedByProvider` is the one deliberately unscoped read here:
      // the nightly export runs for every tenant at once. It must still be
      // narrow — CONNECTED and not soft-deleted — or the sweep would try to
      // push through revoked credentials.
      await repository.listConnectedByProvider(PROVIDER);

      expect(argsOf(prisma.realty_integration_connections.findMany).where).toEqual({
        provider: PROVIDER,
        status: 'CONNECTED',
        deleted_at: null,
      });
    });
  });

  // ─────────────────────────────────────────────
  // upsertConnection
  // ─────────────────────────────────────────────

  describe('upsertConnection — creating', () => {
    it('defaults every optional column when nothing is supplied', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, {});

      expect(argsOf(prisma.realty_integration_connections.create).data).toEqual({
        business_id: BUSINESS_ID,
        provider: PROVIDER,
        status: 'DISCONNECTED',
        config: {},
        external_ref: null,
        last_error: null,
        metadata: {},
      });
    });

    it('carries the supplied values through', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, {
        status: 'CONNECTED',
        config: { refreshToken: 'rt-1' },
        externalRef: 'sheet-abc',
        lastError: null,
        metadata: { sheetTitle: 'Leads' },
      });

      expect(argsOf(prisma.realty_integration_connections.create).data).toMatchObject({
        status: 'CONNECTED',
        config: { refreshToken: 'rt-1' },
        external_ref: 'sheet-abc',
        metadata: { sheetTitle: 'Leads' },
      });
    });
  });

  describe('upsertConnection — updating an existing row', () => {
    beforeEach(() => {
      prisma.realty_integration_connections.findFirst.mockResolvedValue({
        id: CONNECTION_ID,
      });
    });

    it('updates in place rather than creating a second connection', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, { status: 'CONNECTED' });

      expect(prisma.realty_integration_connections.create).not.toHaveBeenCalled();
      expect(argsOf(prisma.realty_integration_connections.update).where).toEqual({
        id: CONNECTION_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('touches only the field it was given', async () => {
      // The failure this guards: marking a connection ERROR also blanking the
      // stored OAuth credentials, so the next sync cannot authenticate.
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, { status: 'ERROR' });

      expect(argsOf(prisma.realty_integration_connections.update).data).toEqual({
        status: 'ERROR',
      });
    });

    it('sends an empty patch when given an empty object', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, {});

      expect(argsOf(prisma.realty_integration_connections.update).data).toEqual({});
    });

    it('distinguishes clearing a field from omitting it', async () => {
      // Clearing `last_error` is how a connection recovers; if `null` were
      // treated as "not supplied" the row would stay in ERROR forever.
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, {
        lastError: null,
        externalRef: null,
      });

      expect(argsOf(prisma.realty_integration_connections.update).data).toEqual({
        last_error: null,
        external_ref: null,
      });
    });

    it('writes every field when every field is supplied', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, {
        status: 'CONNECTED',
        config: { refreshToken: 'rt-2' },
        externalRef: 'sheet-xyz',
        lastError: null,
        metadata: { rows: 10 },
      });

      expect(argsOf(prisma.realty_integration_connections.update).data).toEqual({
        status: 'CONNECTED',
        config: { refreshToken: 'rt-2' },
        external_ref: 'sheet-xyz',
        last_error: null,
        metadata: { rows: 10 },
      });
    });

    it('accepts an empty config object as a real value', async () => {
      await repository.upsertConnection(BUSINESS_ID, PROVIDER, { config: {} });

      expect(argsOf(prisma.realty_integration_connections.update).data).toEqual({
        config: {},
      });
    });
  });

  // ─────────────────────────────────────────────
  // recordSync
  // ─────────────────────────────────────────────

  describe('recordSync', () => {
    it('marks a clean run CONNECTED and counts it', async () => {
      await repository.recordSync(BUSINESS_ID, CONNECTION_ID, null);

      const { where, data } = argsOf(prisma.realty_integration_connections.update);
      expect(where).toEqual({ id: CONNECTION_ID, business_id: BUSINESS_ID });
      expect(data).toMatchObject({
        last_error: null,
        status: 'CONNECTED',
        sync_count: { increment: 1 },
      });
    });

    it('marks a failed run ERROR and keeps the reason', async () => {
      await repository.recordSync(BUSINESS_ID, CONNECTION_ID, 'invalid_grant');

      expect(argsOf(prisma.realty_integration_connections.update).data).toMatchObject({
        status: 'ERROR',
        last_error: 'invalid_grant',
      });
    });

    it('omits the pushed counter when nothing was pushed', async () => {
      // `pushed_count: { increment: 0 }` is a pointless write; more to the
      // point, the branch exists and only one arm was ever exercised.
      await repository.recordSync(BUSINESS_ID, CONNECTION_ID, null);

      expect(argsOf(prisma.realty_integration_connections.update).data).not.toHaveProperty(
        'pushed_count',
      );
    });

    it('increments the pushed counter by the rows actually written', async () => {
      await repository.recordSync(BUSINESS_ID, CONNECTION_ID, null, 25);

      expect(argsOf(prisma.realty_integration_connections.update).data).toMatchObject({
        pushed_count: { increment: 25 },
      });
    });

    it('increments both counters even on a partially failed run', async () => {
      await repository.recordSync(BUSINESS_ID, CONNECTION_ID, 'rate limited', 5);

      expect(argsOf(prisma.realty_integration_connections.update).data).toMatchObject({
        status: 'ERROR',
        sync_count: { increment: 1 },
        pushed_count: { increment: 5 },
      });
    });
  });

  describe('softDeleteConnection', () => {
    it('stamps deleted_at and disconnects, scoped to the tenant', async () => {
      await repository.softDeleteConnection(BUSINESS_ID, PROVIDER);

      const { where, data } = argsOf(prisma.realty_integration_connections.updateMany);
      // Root rule #5: soft delete only.
      expect(where).toEqual({
        business_id: BUSINESS_ID,
        provider: PROVIDER,
        deleted_at: null,
      });
      expect(data).toMatchObject({ status: 'DISCONNECTED', deleted_at: expect.any(Date) });
    });
  });

  // ─────────────────────────────────────────────
  // EOI requests
  // ─────────────────────────────────────────────

  describe('createEoi', () => {
    const REQUIRED = {
      businessId: BUSINESS_ID,
      leadId: LEAD_ID,
      amount: 5_000_00,
    };

    it('defaults currency, token label and the optional references', async () => {
      await repository.createEoi(REQUIRED as never);

      expect(argsOf(prisma.realty_eoi_requests.create).data).toEqual({
        business_id: BUSINESS_ID,
        lead_id: LEAD_ID,
        unit_id: null,
        amount: 5_000_00,
        currency: 'INR',
        token_label: 'टोकन',
        requested_by: null,
        notes: {},
      });
    });

    it('carries the supplied references through', async () => {
      await repository.createEoi({
        ...REQUIRED,
        unitId: UNIT_ID,
        currency: 'INR',
        tokenLabel: 'Token amount',
        requestedBy: USER_ID,
        notes: { source: 'site-visit' },
      } as never);

      expect(argsOf(prisma.realty_eoi_requests.create).data).toMatchObject({
        unit_id: UNIT_ID,
        token_label: 'Token amount',
        requested_by: USER_ID,
        notes: { source: 'site-visit' },
      });
    });
  });

  describe('EOI lookups', () => {
    it('scopes findEoi to the tenant', async () => {
      await repository.findEoi(BUSINESS_ID, EOI_ID);

      expect(argsOf(prisma.realty_eoi_requests.findFirst).where).toEqual({
        id: EOI_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('scopes the payment-link lookup to the tenant on the authenticated path', async () => {
      await repository.findEoiByPaymentLink(BUSINESS_ID, 'plink_1');

      expect(argsOf(prisma.realty_eoi_requests.findFirst).where).toEqual({
        business_id: BUSINESS_ID,
        payment_link_id: 'plink_1',
      });
    });

    it('resolves by payment link alone on the webhook path', async () => {
      // Deliberately unscoped: Razorpay's callback names a payment link, not a
      // tenant, so the EOI is what *establishes* the tenant. Safe because the
      // link id is a gateway-issued opaque token, not a guessable id — and it
      // is the only unscoped read in this repository.
      await repository.findAnyEoiByPaymentLink('plink_2');

      expect(argsOf(prisma.realty_eoi_requests.findFirst).where).toEqual({
        payment_link_id: 'plink_2',
      });
    });
  });

  describe('listEoi', () => {
    it('filters on the tenant alone when no filters are given', async () => {
      await repository.listEoi(BUSINESS_ID);

      expect(argsOf(prisma.realty_eoi_requests.findMany).where).toEqual({
        business_id: BUSINESS_ID,
      });
    });

    it('narrows by lead', async () => {
      await repository.listEoi(BUSINESS_ID, { leadId: LEAD_ID });

      expect(argsOf(prisma.realty_eoi_requests.findMany).where).toEqual({
        business_id: BUSINESS_ID,
        lead_id: LEAD_ID,
      });
    });

    it('narrows by status', async () => {
      await repository.listEoi(BUSINESS_ID, { status: 'PAID' as never });

      expect(argsOf(prisma.realty_eoi_requests.findMany).where).toEqual({
        business_id: BUSINESS_ID,
        status: 'PAID',
      });
    });

    it('applies both filters together', async () => {
      await repository.listEoi(BUSINESS_ID, {
        leadId: LEAD_ID,
        status: 'PENDING' as never,
      });

      expect(argsOf(prisma.realty_eoi_requests.findMany).where).toEqual({
        business_id: BUSINESS_ID,
        lead_id: LEAD_ID,
        status: 'PENDING',
      });
    });
  });

  /**
   * The settlement claim.
   *
   * Two settlements race here as a matter of course: Razorpay redelivers
   * `payment_link.paid` whenever our response is slow, and the operator-facing
   * reconcile route exists to be used exactly when a webhook looks missing, so
   * the two run concurrently by design. Deciding "already paid?" from a row read
   * before the write lets both callers pass the check, both write PAID, and both
   * advance the lead and emit `realty.eoi.paid` — double-counting token money
   * that was paid once.
   *
   * The `status: { not: PAID }` predicate is what makes the answer trustworthy:
   * under READ COMMITTED the loser blocks on the row lock, re-evaluates once the
   * winner commits, and matches nothing.
   */
  describe('settleEoiAsPaid', () => {
    const PAID_AT = new Date('2026-08-15T09:00:00Z');

    beforeEach(() => {
      prisma.realty_eoi_requests.findFirst.mockResolvedValue({ id: EOI_ID });
      prisma.realty_eoi_requests.updateMany.mockResolvedValue({ count: 1 });
    });

    it('only claims a row that is not already paid', async () => {
      await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT);

      expect(argsOf(prisma.realty_eoi_requests.updateMany).where).toEqual({
        id: EOI_ID,
        business_id: BUSINESS_ID,
        status: { not: 'PAID' },
      });
    });

    it('still scopes the write to the tenant', async () => {
      // The webhook driving this is @Public(); the tenant comes from the stored
      // EOI, and this guard is what keeps a link id from settling another
      // business's row.
      await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT);

      expect(argsOf(prisma.realty_eoi_requests.updateMany).where).toMatchObject({
        business_id: BUSINESS_ID,
      });
    });

    it('reports the claim when it moved the row', async () => {
      prisma.realty_eoi_requests.updateMany.mockResolvedValue({ count: 1 });

      const result = await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT);

      expect(result.claimed).toBe(true);
    });

    /**
     * The whole point. A caller told `false` must not re-emit the paid event or
     * re-advance the lead — that is the only thing standing between a redelivered
     * webhook and a double-counted booking.
     */
    it('reports no claim when another caller got there first', async () => {
      prisma.realty_eoi_requests.updateMany.mockResolvedValue({ count: 0 });

      const result = await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT);

      expect(result.claimed).toBe(false);
      // It still returns the row, so the caller has the settled state to map.
      expect(result.eoi).toBeTruthy();
    });

    it('records the paid timestamp and the gateway payment id', async () => {
      await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT);

      expect(argsOf(prisma.realty_eoi_requests.updateMany).data).toEqual({
        status: 'PAID',
        paid_at: PAID_AT,
        gateway_payment_id: 'pay_1',
      });
    });

    /**
     * A reconcile that could not read a payment id must not blank the one the
     * webhook already recorded — the two paths settle the same row and only one
     * of them is guaranteed to know the payment.
     */
    it('leaves the payment id alone when the gateway named none', async () => {
      await repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, null, PAID_AT);

      const data = argsOf(prisma.realty_eoi_requests.updateMany).data as Record<string, unknown>;
      expect(data).toEqual({ status: 'PAID', paid_at: PAID_AT });
      expect('gateway_payment_id' in data).toBe(false);
    });

    it('throws when the row cannot be re-read', async () => {
      prisma.realty_eoi_requests.findFirst.mockResolvedValue(null);

      await expect(
        repository.settleEoiAsPaid(BUSINESS_ID, EOI_ID, 'pay_1', PAID_AT),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe('updateEoi', () => {
    beforeEach(() => {
      prisma.realty_eoi_requests.findFirst.mockResolvedValue({ id: EOI_ID });
    });

    it('scopes the write to the tenant', async () => {
      // The Razorpay webhook that drives this route is @Public(); the tenant
      // comes from the EOI, and this guard is what keeps a link id from
      // updating a row in a different business.
      await repository.updateEoi(BUSINESS_ID, EOI_ID, { status: 'PAID' as never });

      expect(argsOf(prisma.realty_eoi_requests.updateMany).where).toEqual({
        id: EOI_ID,
        business_id: BUSINESS_ID,
      });
    });

    it('sends only the fields it was given', async () => {
      await repository.updateEoi(BUSINESS_ID, EOI_ID, { status: 'SENT' as never });

      expect(argsOf(prisma.realty_eoi_requests.updateMany).data).toEqual({
        status: 'SENT',
      });
    });

    it('maps every optional field onto its column', async () => {
      const at = new Date('2026-08-10T12:00:00Z');

      await repository.updateEoi(BUSINESS_ID, EOI_ID, {
        status: 'PAID' as never,
        paymentLinkId: 'plink_3',
        paymentLinkUrl: 'https://rzp.io/i/abc',
        gatewayPaymentId: 'pay_1',
        approvedBy: USER_ID,
        approvedAt: at,
        sentAt: at,
        paidAt: at,
        expiresAt: at,
        rejectReason: 'buyer withdrew',
        notes: { note: 'x' },
      });

      expect(argsOf(prisma.realty_eoi_requests.updateMany).data).toEqual({
        status: 'PAID',
        payment_link_id: 'plink_3',
        payment_link_url: 'https://rzp.io/i/abc',
        gateway_payment_id: 'pay_1',
        approved_by: USER_ID,
        approved_at: at,
        sent_at: at,
        paid_at: at,
        expires_at: at,
        reject_reason: 'buyer withdrew',
        notes: { note: 'x' },
      });
    });

    it('distinguishes clearing a field from omitting it', async () => {
      // Un-approving an EOI means writing nulls; a truthiness guard would make
      // it a no-op and leave the approval standing.
      await repository.updateEoi(BUSINESS_ID, EOI_ID, {
        approvedBy: null,
        approvedAt: null,
        rejectReason: null,
      });

      expect(argsOf(prisma.realty_eoi_requests.updateMany).data).toEqual({
        approved_by: null,
        approved_at: null,
        reject_reason: null,
      });
    });

    it('re-reads within the tenant and returns the fresh row', async () => {
      const result = await repository.updateEoi(BUSINESS_ID, EOI_ID, {
        status: 'PAID' as never,
      });

      expect(argsOf(prisma.realty_eoi_requests.findFirst).where).toEqual({
        id: EOI_ID,
        business_id: BUSINESS_ID,
      });
      expect(result).toEqual({ id: EOI_ID });
    });

    it('throws when the row is not visible to this tenant after the write', async () => {
      // `updateMany` reports a count rather than throwing, so a cross-tenant id
      // updates nothing and the re-read comes back empty. Returning undefined
      // there would let the webhook report a payment it never recorded.
      prisma.realty_eoi_requests.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateEoi(BUSINESS_ID, EOI_ID, { status: 'PAID' as never })
        .then(
          () => null,
          (err: unknown) => err,
        );

      // `stage` is what separates this from an ordinary "no such EOI" read —
      // it says the write itself matched nothing.
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'EOI',
        resourceId: EOI_ID,
        businessId: BUSINESS_ID,
        stage: 'after-update',
      });
    });
  });
});
