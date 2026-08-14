/**
 * RealtyEoiController unit tests — the EOI (टोकन) console + payment endpoints.
 *
 * The controller carries no business logic, so what is worth asserting is
 * exactly what a controller can get wrong: which tenant and which user each
 * call is attributed to, and the one piece of real logic it does own — the
 * raw-body/signature handling on the `@Public()` Razorpay webhook.
 *
 * Attribution matters here more than on a typical console. Approving an EOI
 * generates and sends a payment link, and the acting user is recorded against
 * it; passing the wrong id makes the money trail name the wrong broker.
 */

import { BadRequestException } from '@nestjs/common';
import { RealtyEoiStatus } from '@prisma/client';
import type { Request } from 'express';

import { RealtyEoiController } from './eoi.controller';
import type { EoiService } from './eoi.service';

const BIZ = '00000000-0000-4000-a000-00000000000a';
const USER = '00000000-0000-4000-a000-00000000000b';
const EOI_ID = '00000000-0000-4000-b000-000000000001';

function build() {
  const eoi = {
    requestEoi: jest.fn().mockResolvedValue({ id: EOI_ID }),
    listEoi: jest.fn().mockResolvedValue([]),
    getEoi: jest.fn().mockResolvedValue({ id: EOI_ID }),
    approveEoi: jest.fn().mockResolvedValue({ ok: true }),
    rejectEoi: jest.fn().mockResolvedValue({ ok: true }),
    reconcileEoi: jest.fn().mockResolvedValue({ ok: true }),
    handleRazorpayWebhook: jest.fn().mockResolvedValue({ handled: true }),
  };
  return { eoi, controller: new RealtyEoiController(eoi as unknown as EoiService) };
}

/** An express request with (or without) the raw bytes the HMAC needs. */
function req(over: { rawBody?: Buffer; body?: unknown } = {}): Request & { rawBody?: Buffer } {
  return over as Request & { rawBody?: Buffer };
}

describe('RealtyEoiController', () => {
  describe('console routes', () => {
    it('attributes a token request to the caller’s tenant and user', async () => {
      const { controller, eoi } = build();
      const dto = { leadId: 'lead-1', amountPaise: 2_500_000 };

      await controller.request(BIZ, USER, dto as never);

      expect(eoi.requestEoi).toHaveBeenCalledWith(BIZ, dto, USER);
    });

    it('passes both list filters through, and neither when absent', async () => {
      const { controller, eoi } = build();

      await controller.list(BIZ, 'lead-1', RealtyEoiStatus.PENDING_APPROVAL);
      expect(eoi.listEoi).toHaveBeenCalledWith(BIZ, {
        leadId: 'lead-1',
        status: RealtyEoiStatus.PENDING_APPROVAL,
      });

      await controller.list(BIZ);
      expect(eoi.listEoi).toHaveBeenLastCalledWith(BIZ, {
        leadId: undefined,
        status: undefined,
      });
    });

    it('scopes a single read to the tenant', async () => {
      const { controller, eoi } = build();

      await controller.get(BIZ, EOI_ID);

      expect(eoi.getEoi).toHaveBeenCalledWith(BIZ, EOI_ID);
    });

    it('records the approving broker, since approval sends a payment link', async () => {
      const { controller, eoi } = build();

      await controller.approve(BIZ, USER, EOI_ID, { expiryMinutes: 30 } as never);

      expect(eoi.approveEoi).toHaveBeenCalledWith(BIZ, EOI_ID, USER, 30);
    });

    it('leaves the expiry to the service when the broker does not set one', async () => {
      const { controller, eoi } = build();

      await controller.approve(BIZ, USER, EOI_ID, {} as never);

      // undefined, not a controller-invented default — the service owns the
      // link's lifetime.
      expect(eoi.approveEoi).toHaveBeenCalledWith(BIZ, EOI_ID, USER, undefined);
    });

    it('records the rejecting broker and their reason', async () => {
      const { controller, eoi } = build();

      await controller.reject(BIZ, USER, EOI_ID, { reason: 'budget mismatch' } as never);

      expect(eoi.rejectEoi).toHaveBeenCalledWith(BIZ, EOI_ID, USER, 'budget mismatch');
    });

    it('scopes a reconcile to the tenant', async () => {
      const { controller, eoi } = build();

      await controller.reconcile(BIZ, EOI_ID);

      expect(eoi.reconcileEoi).toHaveBeenCalledWith(BIZ, EOI_ID);
    });
  });

  describe('razorpay webhook', () => {
    it('hands the raw bytes to the verifier, untouched', async () => {
      const { controller, eoi } = build();
      // Byte-exact: the HMAC is over what Razorpay actually sent, so anything
      // that reparses or reformats the payload invalidates the signature.
      const raw = Buffer.from('{"event":"payment_link.paid"}');

      await controller.webhook(req({ rawBody: raw, body: { event: 'other' } }), 'sig_abc');

      expect(eoi.handleRazorpayWebhook).toHaveBeenCalledWith(raw, 'sig_abc');
      expect(eoi.handleRazorpayWebhook.mock.calls[0][0]).toBe(raw);
    });

    it('rejects a delivery with no signature header before doing any work', async () => {
      const { controller, eoi } = build();

      await expect(
        controller.webhook(req({ rawBody: Buffer.from('{}') }), '' as unknown as string),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Unsigned payloads never reach the settlement path.
      expect(eoi.handleRazorpayWebhook).not.toHaveBeenCalled();
    });

    it('rejects an undefined signature header the same way', async () => {
      const { controller, eoi } = build();

      await expect(
        controller.webhook(req({ rawBody: Buffer.from('{}') }), undefined as unknown as string),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(eoi.handleRazorpayWebhook).not.toHaveBeenCalled();
    });

    /**
     * The fallback when `rawBody` is absent (a misconfigured body parser).
     *
     * It re-serialises the parsed body, which will not byte-match the original
     * payload in general — so verification fails and the delivery is rejected.
     * That is the safe direction: the fallback cannot let an unsigned payload
     * through, it can only cause a legitimate one to be retried.
     */
    it('falls back to the re-serialised body when the raw bytes are missing', async () => {
      const { controller, eoi } = build();

      await controller.webhook(req({ body: { event: 'payment_link.paid' } }), 'sig_abc');

      const passed = eoi.handleRazorpayWebhook.mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(passed)).toBe(true);
      expect(passed.toString()).toBe('{"event":"payment_link.paid"}');
    });

    it('falls back to an empty object when there is no body at all', async () => {
      const { controller, eoi } = build();

      await controller.webhook(req({}), 'sig_abc');

      expect((eoi.handleRazorpayWebhook.mock.calls[0][0] as Buffer).toString()).toBe('{}');
    });
  });
});
