/**
 * EoiService unit tests. Repository, leads service, Razorpay gateway, and
 * EventEmitter2 are mocked — no DB, no gateway calls.
 *
 * Coverage: request (pending), the broker approval gate (link generation + guard
 * against non-pending), rejection, the paid-webhook (signature + correlation +
 * lead stage advance), reconciliation, and idempotent settlement.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { ConflictError, ErrorCode } from '@gosumo/shared';
import { Prisma, RealtyEoiStatus } from '@prisma/client';
import type { realty_eoi_requests } from '@prisma/client';
import { LeadStage } from '@gosumo/shared';

import { EoiService } from './eoi.service';
import { RealtyIntegrationsRepository } from '../realty-integrations.repository';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { RazorpayService } from '../../payment/razorpay.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const LEAD_ID = '00000000-0000-4000-a000-0000000000aa';
const EOI_ID = '00000000-0000-4000-a000-0000000000bb';

function makeEoi(overrides: Partial<realty_eoi_requests> = {}): realty_eoi_requests {
  return {
    id: EOI_ID,
    business_id: BUSINESS_ID,
    lead_id: LEAD_ID,
    unit_id: null,
    amount: new Prisma.Decimal(25000),
    currency: 'INR',
    token_label: 'टोकन',
    status: RealtyEoiStatus.PENDING_APPROVAL,
    payment_link_id: null,
    payment_link_url: null,
    gateway_payment_id: null,
    requested_by: null,
    approved_by: null,
    approved_at: null,
    sent_at: null,
    paid_at: null,
    expires_at: null,
    reject_reason: null,
    notes: {},
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as realty_eoi_requests;
}

describe('EoiService', () => {
  let service: EoiService;
  let repo: jest.Mocked<RealtyIntegrationsRepository>;
  let leads: jest.Mocked<RealtyLeadsService>;
  let razorpay: jest.Mocked<RazorpayService>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(() => {
    repo = {
      createEoi: jest.fn(),
      findEoi: jest.fn(),
      findEoiByPaymentLink: jest.fn(),
      findAnyEoiByPaymentLink: jest.fn(),
      updateEoi: jest.fn(),
      // The settlement path claims PAID atomically instead of guarding on a
      // status read before the write; `claimed` says whether this caller won.
      settleEoiAsPaid: jest.fn(),
      listEoi: jest.fn(),
    } as unknown as jest.Mocked<RealtyIntegrationsRepository>;
    leads = {
      getLead: jest.fn(),
      advanceStage: jest.fn(),
    } as unknown as jest.Mocked<RealtyLeadsService>;
    razorpay = {
      createPaymentLink: jest.fn(),
      fetchPaymentLinkStatus: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    } as unknown as jest.Mocked<RazorpayService>;
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;

    service = new EoiService(repo, leads, razorpay, emitter);
  });

  function stubLead(): void {
    leads.getLead.mockResolvedValue({
      id: LEAD_ID,
      name: 'Rahul',
      email: 'r@example.com',
      whatsappPhone: '+919876543210',
    } as never);
  }

  describe('requestEoi', () => {
    it('validates the lead, creates a PENDING request, and emits requested', async () => {
      stubLead();
      repo.createEoi.mockResolvedValue(makeEoi());

      const res = await service.requestEoi(BUSINESS_ID, {
        leadId: LEAD_ID,
        amountPaise: 2500000,
      });

      expect(leads.getLead).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID);
      expect(res.status).toBe(RealtyEoiStatus.PENDING_APPROVAL);
      expect(res.amountPaise).toBe(2500000);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.eoi.requested',
        expect.objectContaining({ eoiId: EOI_ID, amountPaise: 2500000 }),
      );
      // No payment link is created before broker approval.
      expect(razorpay.createPaymentLink).not.toHaveBeenCalled();
    });
  });

  describe('approveEoi (broker approval gate)', () => {
    it('generates a Razorpay link, marks LINK_SENT, and emits approved', async () => {
      stubLead();
      repo.findEoi.mockResolvedValue(makeEoi());
      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_1',
        shortUrl: 'https://rzp.io/i/abc',
        url: 'https://rzp.io/i/abc',
        status: 'created',
        amountPaise: 2500000,
      });
      repo.updateEoi.mockResolvedValue(
        makeEoi({
          status: RealtyEoiStatus.LINK_SENT,
          payment_link_id: 'plink_1',
          payment_link_url: 'https://rzp.io/i/abc',
        }),
      );

      const res = await service.approveEoi(BUSINESS_ID, EOI_ID, 'broker-1');

      expect(razorpay.createPaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({
          amountPaise: 2500000,
          referenceId: EOI_ID,
          notes: expect.objectContaining({ eoiId: EOI_ID, kind: 'realty_eoi' }),
        }),
      );
      expect(res.status).toBe(RealtyEoiStatus.LINK_SENT);
      expect(res.paymentLinkId).toBe('plink_1');
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.eoi.approved',
        expect.objectContaining({ paymentLinkId: 'plink_1' }),
      );
    });

    it('refuses to approve anything that is not PENDING_APPROVAL', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      await expect(service.approveEoi(BUSINESS_ID, EOI_ID, 'b')).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(razorpay.createPaymentLink).not.toHaveBeenCalled();
    });

    /**
     * The taxonomy exists so callers branch on `code` and queue consumers on
     * `retryable`. A wrong-state EOI will be wrong-state on every retry, so
     * re-running it must never look worth attempting again.
     */
    it('carries the conflict taxonomy: 409, CONFLICT, not retryable', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));

      let err: ConflictError | undefined;
      try {
        await service.approveEoi(BUSINESS_ID, EOI_ID, 'b');
      } catch (e: unknown) {
        err = e as ConflictError;
      }

      if (!err) throw new Error('expected approveEoi to reject');
      expect(err.code).toBe(ErrorCode.CONFLICT);
      expect(err.httpStatus).toBe(409);
      expect(err.retryable).toBe(false);
      // Ids belong in `context`, which the filter logs and never serialises.
      expect(err.context).toMatchObject({
        businessId: BUSINESS_ID,
        eoiId: EOI_ID,
        status: RealtyEoiStatus.PAID,
        action: 'approve',
      });
    });
  });

  describe('rejectEoi', () => {
    it('marks a pending request REJECTED with the reason', async () => {
      repo.findEoi.mockResolvedValue(makeEoi());
      repo.updateEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.REJECTED, reject_reason: 'price too low' }),
      );
      const res = await service.rejectEoi(BUSINESS_ID, EOI_ID, 'broker-1', 'price too low');
      expect(res.status).toBe(RealtyEoiStatus.REJECTED);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.eoi.rejected',
        expect.objectContaining({ reason: 'price too low' }),
      );
    });
  });

  describe('handleRazorpayWebhook', () => {
    const paidPayload = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1', status: 'paid' } },
        payment: {
          entity: {
            id: 'pay_1',
            notes: { kind: 'realty_eoi', businessId: BUSINESS_ID, eoiId: EOI_ID },
          },
        },
      },
    });

    it('rejects an invalid signature before doing anything', async () => {
      razorpay.verifyWebhookSignature.mockReturnValue(false);
      await expect(
        service.handleRazorpayWebhook(paidPayload, 'bad'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('settles the EOI as PAID and advances the lead stage', async () => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repo.findEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID, payment_link_id: 'plink_1' }),
        claimed: true,
      });

      const res = await service.handleRazorpayWebhook(paidPayload, 'sig');

      expect(res).toEqual({ handled: true });
      expect(repo.settleEoiAsPaid).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        'pay_1',
        expect.any(Date),
      );
      expect(leads.advanceStage).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, LeadStage.NEGOTIATING);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.eoi.paid',
        expect.objectContaining({ eoiId: EOI_ID, gatewayPaymentId: 'pay_1' }),
      );
    });

    it('ignores non payment_link.paid events', async () => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      const res = await service.handleRazorpayWebhook(
        JSON.stringify({ event: 'payment.captured', payload: {} }),
        'sig',
      );
      expect(res).toEqual({ handled: false });
      expect(repo.updateEoi).not.toHaveBeenCalled();
    });
  });

  describe('reconcileEoi', () => {
    it('settles when the gateway reports the link paid', async () => {
      repo.findEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        id: 'plink_1',
        status: 'paid',
        amountPaidPaise: 2500000,
        paymentId: 'pay_9',
      });
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });

      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);

      expect(res.status).toBe(RealtyEoiStatus.PAID);
      expect(leads.advanceStage).toHaveBeenCalled();
    });

    it('is a no-op for an already-paid EOI (idempotent)', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);
      expect(res.status).toBe(RealtyEoiStatus.PAID);
      expect(razorpay.fetchPaymentLinkStatus).not.toHaveBeenCalled();
    });

    it('refuses to reconcile an EOI that was never approved', async () => {
      // A PENDING_APPROVAL request has no link to poll; without this guard the
      // gateway call would run with an undefined link id.
      repo.findEoi.mockResolvedValue(makeEoi({ payment_link_id: null }));

      await expect(service.reconcileEoi(BUSINESS_ID, EOI_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(razorpay.fetchPaymentLinkStatus).not.toHaveBeenCalled();
    });

    it('leaves the EOI alone when the gateway still reports it unpaid', async () => {
      repo.findEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        id: 'plink_1',
        status: 'created',
        amountPaidPaise: 0,
      } as never);

      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);

      expect(res.status).toBe(RealtyEoiStatus.LINK_SENT);
      expect(repo.updateEoi).not.toHaveBeenCalled();
      expect(leads.advanceStage).not.toHaveBeenCalled();
    });

    it('404s for an EOI belonging to another tenant', async () => {
      // `findEoi` is tenant-scoped, so a cross-tenant id simply returns null.
      // The caller must see a plain not-found, never a 500.
      repo.findEoi.mockResolvedValue(null);

      await expect(service.reconcileEoi(BUSINESS_ID, EOI_ID)).rejects.toThrow(/not found/);
    });
  });

  /**
   * The webhook is `@Public()` and money-bearing, so its correlation logic is
   * the part worth driving hardest. Razorpay does not tell us which tenant a
   * payment belongs to — we tell *it*, via the `notes` we attach at link
   * creation, and read them back here. Every way that can go wrong (absent
   * notes, another product's link, an unknown link id, a replayed delivery) has
   * to land somewhere safe.
   */
  describe('handleRazorpayWebhook correlation', () => {
    const webhook = (payload: unknown): string =>
      JSON.stringify({ event: 'payment_link.paid', payload });

    beforeEach(() => {
      razorpay.verifyWebhookSignature.mockReturnValue(true);
    });

    it('scopes the lookup to the tenant named in the link notes', async () => {
      repo.findEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });

      await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: { kind: 'realty_eoi', businessId: BUSINESS_ID } } },
        }),
        'sig',
      );

      // The tenant-scoped read is preferred whenever the notes carry a tenant.
      expect(repo.findEoiByPaymentLink).toHaveBeenCalledWith(BUSINESS_ID, 'plink_1');
      expect(repo.findAnyEoiByPaymentLink).not.toHaveBeenCalled();
    });

    it('falls back to the unscoped lookup only when the notes carry no tenant', async () => {
      // Razorpay strips notes on some link types. The link id is an opaque
      // gateway-issued identifier, so an unscoped lookup on it is safe — and
      // the tenant used for the write comes from the *row*, never the payload.
      repo.findAnyEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });

      await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: {} } },
        }),
        'sig',
      );

      expect(repo.findAnyEoiByPaymentLink).toHaveBeenCalledWith('plink_1');
      expect(repo.settleEoiAsPaid).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.anything(),
        expect.any(Date),
      );
    });

    it('writes against the tenant on the stored row, not the one in the payload', async () => {
      // The decisive anti-IDOR property: an attacker who forged a businessId in
      // notes could at most cause a lookup that finds nothing, because the
      // update is keyed on `eoi.business_id`.
      const OTHER = '00000000-0000-4000-a000-0000000000ff';
      repo.findAnyEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, business_id: BUSINESS_ID }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });

      await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: {} } },
        }),
        'sig',
      );

      expect(repo.settleEoiAsPaid).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.anything(),
        expect.any(Date),
      );
      expect(repo.settleEoiAsPaid).not.toHaveBeenCalledWith(
        OTHER,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('ignores a payment link belonging to another product', async () => {
      // The same Razorpay account serves order payments; a `kind` mismatch
      // means this delivery is not ours to settle.
      const res = await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: { kind: 'order_payment' } } },
        }),
        'sig',
      );

      expect(res).toEqual({ handled: false });
      expect(repo.findEoiByPaymentLink).not.toHaveBeenCalled();
      expect(repo.findAnyEoiByPaymentLink).not.toHaveBeenCalled();
    });

    it('ignores a delivery with no payment_link entity', async () => {
      const res = await service.handleRazorpayWebhook(
        webhook({ payment: { entity: { id: 'pay_1', notes: {} } } }),
        'sig',
      );

      expect(res).toEqual({ handled: false });
      expect(repo.updateEoi).not.toHaveBeenCalled();
    });

    it('ignores a delivery with no payment entity at all', async () => {
      repo.findAnyEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });

      const res = await service.handleRazorpayWebhook(
        webhook({ payment_link: { entity: { id: 'plink_1', status: 'paid' } } }),
        'sig',
      );

      // Still settled — the link is what identifies the EOI. There is simply
      // no gateway payment id to record.
      expect(res).toEqual({ handled: true });
      expect(repo.settleEoiAsPaid).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        null,
        expect.any(Date),
      );
    });

    it('reports unhandled when no EOI matches the link', async () => {
      repo.findAnyEoiByPaymentLink.mockResolvedValue(null);

      const res = await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_unknown', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: {} } },
        }),
        'sig',
      );

      expect(res).toEqual({ handled: false });
      expect(repo.updateEoi).not.toHaveBeenCalled();
    });

    /**
     * Razorpay retries until it sees a 2xx, so the same paid event arrives more
     * than once in normal operation — and the operator-facing reconcile route
     * exists to be used exactly when a webhook looks slow, so the two run
     * concurrently by design.
     *
     * Idempotency is decided in the database, not from the status on a row read
     * before the write. Reading it first is what let two concurrent settlements
     * both pass the check, both advance the lead, and both emit
     * `realty.eoi.paid` — double-counting a booking that happened once. The
     * loser here is told `claimed: false` and must do nothing further.
     */
    it('does no settlement work when it loses the claim', async () => {
      repo.findEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT }),
      );
      // What the conditional update reports to the caller that arrived second.
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: false,
      });

      const res = await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: { businessId: BUSINESS_ID } } },
        }),
        'sig',
      );

      // Still a 2xx — the event *was* handled, just not by this caller.
      expect(res).toEqual({ handled: true });
      expect(leads.advanceStage).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith('realty.eoi.paid', expect.anything());
    });

    /**
     * The complement: the settlement is attempted unconditionally, and the
     * database is what decides. A pre-read status check short-circuiting here
     * is the bug — it looks like idempotency and is not.
     */
    it('always attempts the claim rather than trusting a pre-read status', async () => {
      repo.findEoiByPaymentLink.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: false,
      });

      await service.handleRazorpayWebhook(
        webhook({
          payment_link: { entity: { id: 'plink_1', status: 'paid' } },
          payment: { entity: { id: 'pay_1', notes: { businessId: BUSINESS_ID } } },
        }),
        'sig',
      );

      expect(repo.settleEoiAsPaid).toHaveBeenCalledTimes(1);
      expect(emitter.emit).not.toHaveBeenCalledWith('realty.eoi.paid', expect.anything());
    });

    it('accepts a Buffer raw body', async () => {
      // Express hands the raw body through as a Buffer; the signature is
      // verified over those bytes, so the parse must accept them too.
      repo.findEoiByPaymentLink.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: false,
      });

      const res = await service.handleRazorpayWebhook(
        Buffer.from(
          webhook({
            payment_link: { entity: { id: 'plink_1', status: 'paid' } },
            payment: { entity: { id: 'pay_1', notes: { businessId: BUSINESS_ID } } },
          }),
          'utf8',
        ),
        'sig',
      );

      expect(res).toEqual({ handled: true });
    });

    it('verifies the signature before parsing the body', async () => {
      // Root rule #3. A parse-first implementation would throw a SyntaxError on
      // garbage from an unauthenticated caller instead of a clean 400.
      razorpay.verifyWebhookSignature.mockReturnValue(false);

      await expect(service.handleRazorpayWebhook('not json at all', 'bad')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('EOI settlement resilience', () => {
    it('still records the payment when the lead stage transition fails', async () => {
      // Money has moved. A lead in the wrong stage is a reporting problem; an
      // EOI stuck at LINK_SENT is a double-charge waiting to happen.
      razorpay.verifyWebhookSignature.mockReturnValue(true);
      repo.findEoiByPaymentLink.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      repo.settleEoiAsPaid.mockResolvedValue({
        eoi: makeEoi({ status: RealtyEoiStatus.PAID }),
        claimed: true,
      });
      leads.advanceStage.mockRejectedValue(new Error('illegal stage transition'));

      const res = await service.handleRazorpayWebhook(
        JSON.stringify({
          event: 'payment_link.paid',
          payload: {
            payment_link: { entity: { id: 'plink_1', status: 'paid' } },
            payment: { entity: { id: 'pay_1', notes: { businessId: BUSINESS_ID } } },
          },
        }),
        'sig',
      );

      expect(res).toEqual({ handled: true });
      expect(repo.settleEoiAsPaid).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.anything(),
        expect.any(Date),
      );
      expect(emitter.emit).toHaveBeenCalledWith('realty.eoi.paid', expect.anything());
    });
  });

  describe('reads and guards', () => {
    it('getEoi maps a stored row to the API shape, converting rupees to paise', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ amount: new Prisma.Decimal('25000.50') }));

      // Root rule #4: the API boundary speaks integer paise.
      await expect(service.getEoi(BUSINESS_ID, EOI_ID)).resolves.toMatchObject({
        id: EOI_ID,
        businessId: BUSINESS_ID,
        amountPaise: 2500050,
      });
    });

    it('getEoi 404s rather than leaking that a row exists under another tenant', async () => {
      repo.findEoi.mockResolvedValue(null);
      await expect(service.getEoi(BUSINESS_ID, EOI_ID)).rejects.toThrow(/not found/);
    });

    it('listEoi passes filters through and maps every row', async () => {
      repo.listEoi.mockResolvedValue([makeEoi(), makeEoi({ id: 'other' })]);

      const rows = await service.listEoi(BUSINESS_ID, { status: RealtyEoiStatus.PAID });

      expect(repo.listEoi).toHaveBeenCalledWith(BUSINESS_ID, { status: RealtyEoiStatus.PAID });
      expect(rows.map((r) => r.id)).toEqual([EOI_ID, 'other']);
    });

    it('listEoi defaults to no filters', async () => {
      repo.listEoi.mockResolvedValue([]);
      await service.listEoi(BUSINESS_ID);
      expect(repo.listEoi).toHaveBeenCalledWith(BUSINESS_ID, {});
    });

    it('refuses to reject anything that is not PENDING_APPROVAL', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));

      await expect(
        service.rejectEoi(BUSINESS_ID, EOI_ID, 'user-1', 'duplicate'),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(repo.updateEoi).not.toHaveBeenCalled();
    });

    it('approveEoi describes the link with the phone when the lead has no name', async () => {
      leads.getLead.mockResolvedValue({
        id: LEAD_ID,
        name: null,
        email: null,
        whatsappPhone: '+919876543210',
      } as never);
      repo.findEoi.mockResolvedValue(makeEoi());
      razorpay.createPaymentLink.mockResolvedValue({
        id: 'plink_1',
        shortUrl: 'https://rzp.io/i/abc',
      } as never);
      repo.updateEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.LINK_SENT }));

      await service.approveEoi(BUSINESS_ID, EOI_ID, 'user-1');

      const arg = razorpay.createPaymentLink.mock.calls[0]![0];
      // The description reaches the payer's SMS, so it cannot read "null".
      expect(arg.description).toContain('+919876543210');
      expect(arg.customer).toMatchObject({ name: undefined, email: undefined });
      // The notes are what make the webhook above tenant-safe.
      expect(arg.notes).toMatchObject({ businessId: BUSINESS_ID, eoiId: EOI_ID, kind: 'realty_eoi' });
    });
  });

  describe('cancelEoi', () => {
    it('cancels a PENDING_APPROVAL EOI', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PENDING_APPROVAL }));
      repo.updateEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.CANCELLED }));

      const res = await service.cancelEoi(BUSINESS_ID, EOI_ID, 'broker-1', 'Changed mind');
      expect(res.status).toBe(RealtyEoiStatus.CANCELLED);
      expect(repo.updateEoi).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.objectContaining({ status: RealtyEoiStatus.CANCELLED }),
      );
    });

    it('cancels a LINK_SENT EOI', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.LINK_SENT }));
      repo.updateEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.CANCELLED }));

      const res = await service.cancelEoi(BUSINESS_ID, EOI_ID, 'broker-1');
      expect(res.status).toBe(RealtyEoiStatus.CANCELLED);
    });

    it('rejects cancelling a PAID EOI', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      await expect(
        service.cancelEoi(BUSINESS_ID, EOI_ID, 'broker-1'),
      ).rejects.toThrow(/cannot be cancelled/i);
    });

    it('rejects cancelling a REJECTED EOI', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.REJECTED }));
      await expect(
        service.cancelEoi(BUSINESS_ID, EOI_ID, 'broker-1'),
      ).rejects.toThrow(/cannot be cancelled/i);
    });
  });

  describe('reconcileEoi — expired link', () => {
    it('marks a LINK_SENT EOI as EXPIRED when Razorpay reports expired', async () => {
      repo.findEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.LINK_SENT, payment_link_id: 'plink_1' }),
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        status: 'expired',
        paymentId: undefined,
      } as never);
      repo.updateEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.EXPIRED }));

      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);
      expect(res.status).toBe(RealtyEoiStatus.EXPIRED);
      expect(repo.updateEoi).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.objectContaining({ status: RealtyEoiStatus.EXPIRED }),
      );
    });

    it('does not mark PENDING_APPROVAL as expired (no link yet)', async () => {
      repo.findEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.PENDING_APPROVAL, payment_link_id: 'plink_1' }),
      );
      razorpay.fetchPaymentLinkStatus.mockResolvedValue({
        status: 'expired',
        paymentId: undefined,
      } as never);

      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);
      expect(res.status).toBe(RealtyEoiStatus.PENDING_APPROVAL);
      expect(repo.updateEoi).not.toHaveBeenCalled();
    });
  });
});
