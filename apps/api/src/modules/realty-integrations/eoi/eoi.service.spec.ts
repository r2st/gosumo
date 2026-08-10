/**
 * EoiService unit tests. Repository, leads service, Razorpay gateway, and
 * EventEmitter2 are mocked — no DB, no gateway calls.
 *
 * Coverage: request (pending), the broker approval gate (link generation + guard
 * against non-pending), rejection, the paid-webhook (signature + correlation +
 * lead stage advance), reconciliation, and idempotent settlement.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, BadRequestException } from '@nestjs/common';
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
      listEoi: jest.fn(),
    } as unknown as jest.Mocked<RealtyIntegrationsRepository>;
    leads = {
      getLead: jest.fn(),
      transitionStage: jest.fn(),
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
        ConflictException,
      );
      expect(razorpay.createPaymentLink).not.toHaveBeenCalled();
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
      repo.updateEoi.mockResolvedValue(
        makeEoi({ status: RealtyEoiStatus.PAID, payment_link_id: 'plink_1' }),
      );

      const res = await service.handleRazorpayWebhook(paidPayload, 'sig');

      expect(res).toEqual({ handled: true });
      expect(repo.updateEoi).toHaveBeenCalledWith(
        BUSINESS_ID,
        EOI_ID,
        expect.objectContaining({ status: RealtyEoiStatus.PAID, gatewayPaymentId: 'pay_1' }),
      );
      expect(leads.transitionStage).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, {
        stage: LeadStage.NEGOTIATING,
      });
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
      repo.updateEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));

      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);

      expect(res.status).toBe(RealtyEoiStatus.PAID);
      expect(leads.transitionStage).toHaveBeenCalled();
    });

    it('is a no-op for an already-paid EOI (idempotent)', async () => {
      repo.findEoi.mockResolvedValue(makeEoi({ status: RealtyEoiStatus.PAID }));
      const res = await service.reconcileEoi(BUSINESS_ID, EOI_ID);
      expect(res.status).toBe(RealtyEoiStatus.PAID);
      expect(razorpay.fetchPaymentLinkStatus).not.toHaveBeenCalled();
    });
  });
});
