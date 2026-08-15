/**
 * PaymentRepository unit tests.
 *
 * The repository is almost entirely optional-field plumbing: every `?? default`
 * and every `if (x !== undefined)` guard changes the shape of the object handed
 * to Prisma. These tests drive both sides of each of those guards and assert on
 * the exact payload, so a dropped field or a flipped default fails loudly.
 *
 * Prisma is mocked; `amount` columns are Decimal(14,2) rupee values, mimicked
 * with a `toString()`-only object exactly as Prisma resolves them at runtime.
 *
 * `getPaymentStats` has its own suite in payment-stats.spec.ts.
 */

import { Prisma } from '@prisma/client';
import { ErrorCode, ResourceNotFoundError } from '@gosumo/shared';
import { PaymentRepository } from './payment.repository';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-0000000000ff';
const PAYMENT_ID = '00000000-0000-4000-a000-000000000010';
const REFUND_ID = '00000000-0000-4000-a000-000000000020';
const INVOICE_ID = '00000000-0000-4000-a000-000000000030';
const CLIENT_ID = '00000000-0000-4000-a000-0000000000aa';
const ORDER_ID = '00000000-0000-4000-a000-0000000000bb';

const decimal = (rupees: number) => ({ toString: () => rupees.toFixed(2) });

type PrismaMock = {
  payments: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    groupBy: jest.Mock;
  };
  refunds: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    aggregate: jest.Mock;
  };
  invoices: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  webhook_events: { create: jest.Mock; update: jest.Mock };
  /** `reserveRefund` locks the payment row with a raw `SELECT … FOR UPDATE`. */
  $queryRaw: jest.Mock;
  /** Runs its callback against the same mock, standing in for the tx client. */
  $transaction: jest.Mock;
};

describe('PaymentRepository', () => {
  let prisma: PrismaMock;
  let repository: PaymentRepository;

  beforeEach(() => {
    prisma = {
      payments: {
        create: jest.fn().mockResolvedValue({ id: PAYMENT_ID }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: PAYMENT_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      refunds: {
        create: jest.fn().mockResolvedValue({ id: REFUND_ID }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: REFUND_ID }),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: null } }),
      },
      invoices: {
        create: jest.fn().mockResolvedValue({ id: INVOICE_ID }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: INVOICE_ID }),
      },
      webhook_events: {
        create: jest.fn().mockResolvedValue({ id: 'wh-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      // Default: the payment exists and is a ₹500 capture.
      $queryRaw: jest.fn().mockResolvedValue([{ amount: decimal(500) }]),
      $transaction: jest.fn(),
    };
    // The interactive form hands the callback a transaction client. Passing the
    // same mock keeps every assertion below pointed at one set of calls, which
    // is also what makes "the aggregate ran inside the transaction" checkable.
    prisma.$transaction.mockImplementation(
      (fn: (tx: PrismaMock) => unknown) => fn(prisma),
    );
    repository = new PaymentRepository(prisma as never);
  });

  // ─────────────────────────────────────────────
  // createPayment
  // ─────────────────────────────────────────────

  describe('createPayment', () => {
    const minimal = {
      businessId: BUSINESS_ID,
      clientId: CLIENT_ID,
      amountRupees: 250.5,
      gateway: 'RAZORPAY',
    };

    it('applies defaults for every omitted optional field', async () => {
      await repository.createPayment(minimal);

      const { data } = prisma.payments.create.mock.calls[0][0];
      expect(data.business_id).toBe(BUSINESS_ID);
      expect(data.status).toBe('PENDING');
      expect(data.order_id).toBeNull();
      expect(data.currency).toBe('INR');
      expect(data.payment_link_url).toBeNull();
      expect(data.payment_link_id).toBeNull();
      expect(data.payment_link_expires_at).toBeNull();
      expect(data.gateway_order_id).toBeNull();
      expect(data.metadata).toEqual({});
      expect(data.gateway_response).toBe(Prisma.JsonNull);
      expect(Number(data.amount)).toBe(250.5);
    });

    it('passes through every supplied optional field', async () => {
      const expiresAt = new Date('2026-01-01T00:00:00.000Z');

      await repository.createPayment({
        ...minimal,
        orderId: ORDER_ID,
        currency: 'USD',
        paymentLinkUrl: 'https://rzp.io/i/abc',
        paymentLinkId: 'plink_abc',
        paymentLinkExpiresAt: expiresAt,
        gatewayOrderId: 'order_abc',
        metadata: { source: 'whatsapp' },
      });

      const { data } = prisma.payments.create.mock.calls[0][0];
      expect(data.order_id).toBe(ORDER_ID);
      expect(data.currency).toBe('USD');
      expect(data.payment_link_url).toBe('https://rzp.io/i/abc');
      expect(data.payment_link_id).toBe('plink_abc');
      expect(data.payment_link_expires_at).toBe(expiresAt);
      expect(data.gateway_order_id).toBe('order_abc');
      expect(data.metadata).toEqual({ source: 'whatsapp' });
    });
  });

  // ─────────────────────────────────────────────
  // getPayment / lookups
  // ─────────────────────────────────────────────

  describe('lookups', () => {
    it('scopes getPayment by business', async () => {
      prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });

      await expect(repository.getPayment(BUSINESS_ID, PAYMENT_ID)).resolves.toEqual({
        id: PAYMENT_ID,
      });
      expect(prisma.payments.findFirst).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID, business_id: BUSINESS_ID },
      });
    });

    it('returns null when the payment belongs to another business', async () => {
      prisma.payments.findFirst.mockResolvedValue(null);

      await expect(
        repository.getPayment(OTHER_BUSINESS_ID, PAYMENT_ID),
      ).resolves.toBeNull();
    });

    it.each([
      [
        'findPaymentByGatewayId',
        'gateway_payment_id',
        'pay_123',
        (r: PaymentRepository, v: string) => r.findPaymentByGatewayId(v),
      ],
      [
        'findPaymentByGatewayOrderId',
        'gateway_order_id',
        'order_123',
        (r: PaymentRepository, v: string) => r.findPaymentByGatewayOrderId(v),
      ],
      [
        'findPaymentByLinkId',
        'payment_link_id',
        'plink_123',
        (r: PaymentRepository, v: string) => r.findPaymentByLinkId(v),
      ],
    ] as const)(
      '%s queries by %s without business scoping',
      async (_method, column, value, invoke) => {
        prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });

        await invoke(repository, value);

        expect(prisma.payments.findFirst).toHaveBeenCalledWith({
          where: { [column]: value },
        });
      },
    );

    it('finds a refund by gateway id without business scoping', async () => {
      prisma.refunds.findFirst.mockResolvedValue({ id: REFUND_ID });

      await repository.findRefundByGatewayId('rfnd_1');

      expect(prisma.refunds.findFirst).toHaveBeenCalledWith({
        where: { gateway_refund_id: 'rfnd_1' },
      });
    });

    it('includes the payment relation when fetching a refund', async () => {
      prisma.refunds.findFirst.mockResolvedValue({ id: REFUND_ID });

      await repository.getRefund(BUSINESS_ID, REFUND_ID);

      expect(prisma.refunds.findFirst).toHaveBeenCalledWith({
        where: { id: REFUND_ID, business_id: BUSINESS_ID },
        include: { payment: true },
      });
    });
  });

  // ─────────────────────────────────────────────
  // listPayments
  // ─────────────────────────────────────────────

  describe('listPayments', () => {
    it('defaults to page 1 / limit 20 and applies no optional filters', async () => {
      prisma.payments.findMany.mockResolvedValue([{ id: PAYMENT_ID }]);
      prisma.payments.count.mockResolvedValue(1);

      const result = await repository.listPayments(BUSINESS_ID, {});

      expect(prisma.payments.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { created_at: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result).toEqual({
        data: [{ id: PAYMENT_ID }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('applies every optional filter and paginates', async () => {
      prisma.payments.count.mockResolvedValue(25);

      const result = await repository.listPayments(BUSINESS_ID, {
        status: 'SUCCESS',
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        page: 3,
        limit: 10,
      });

      expect(prisma.payments.findMany).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          status: 'SUCCESS',
          order_id: ORDER_ID,
          client_id: CLIENT_ID,
        },
        orderBy: { created_at: 'desc' },
        skip: 20,
        take: 10,
      });
      expect(result.totalPages).toBe(3);
      expect(result.page).toBe(3);
    });

    it('reports zero pages for an empty result set', async () => {
      const result = await repository.listPayments(BUSINESS_ID, { limit: 5 });

      expect(result.totalPages).toBe(0);
      expect(result.limit).toBe(5);
    });
  });

  // ─────────────────────────────────────────────
  // claimPaymentSuccess
  // ─────────────────────────────────────────────

  /**
   * Three callers settle the same payment and they overlap routinely:
   * `payment.authorized` and `payment.captured` are separate Razorpay events
   * sent milliseconds apart, they carry different `webhook_events` keys so the
   * idempotency ledger does not collapse them, and the reconcile sweep polls
   * the gateway exactly when a webhook looks late.
   *
   * Deciding "already SUCCESS?" from a row read before the write lets all of
   * them through, and `payment.success` is emitted more than once for money
   * collected once. The predicate below is what makes the answer trustworthy.
   */
  describe('claimPaymentSuccess', () => {
    const CAPTURED_AT = new Date('2026-08-15T09:00:00.000Z');

    beforeEach(() => {
      prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });
    });

    it('only claims a payment that is not already SUCCESS', async () => {
      await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        gatewayPaymentId: 'pay_1',
        capturedAt: CAPTURED_AT,
      });

      expect(prisma.payments.updateMany).toHaveBeenCalledWith({
        where: {
          id: PAYMENT_ID,
          business_id: BUSINESS_ID,
          status: { not: 'SUCCESS' },
        },
        data: expect.objectContaining({ status: 'SUCCESS', captured_at: CAPTURED_AT }),
      });
    });

    it('reports the claim when it moved the row', async () => {
      prisma.payments.updateMany.mockResolvedValue({ count: 1 });

      const result = await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        capturedAt: CAPTURED_AT,
      });

      expect(result.claimed).toBe(true);
    });

    it('reports no claim when another caller got there first', async () => {
      prisma.payments.updateMany.mockResolvedValue({ count: 0 });

      const result = await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        capturedAt: CAPTURED_AT,
      });

      expect(result.claimed).toBe(false);
      // The row still comes back — the loser needs the settled state, it just
      // must not emit for it.
      expect(result.payment).toBeTruthy();
    });

    /**
     * Reconciliation frequently has no method and a null payment id. Writing
     * those over what the webhook recorded would erase the only trace of how
     * the money actually arrived.
     */
    it('leaves fields the caller did not learn untouched', async () => {
      await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        method: null,
        gatewayPaymentId: null,
        capturedAt: CAPTURED_AT,
      });

      const data = (prisma.payments.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> })
        .data;
      expect(data).toEqual({ status: 'SUCCESS', captured_at: CAPTURED_AT });
      expect('method' in data).toBe(false);
      expect('gateway_payment_id' in data).toBe(false);
    });

    it('records what it did learn', async () => {
      await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        method: 'UPI',
        gatewayPaymentId: 'pay_1',
        gatewayResponse: { ok: true },
        capturedAt: CAPTURED_AT,
      });

      expect(
        (prisma.payments.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data,
      ).toEqual({
        status: 'SUCCESS',
        captured_at: CAPTURED_AT,
        method: 'UPI',
        gateway_payment_id: 'pay_1',
        gateway_response: { ok: true },
      });
    });

    it('is scoped to the tenant on both the write and the re-read', async () => {
      await repository.claimPaymentSuccess(BUSINESS_ID, PAYMENT_ID, {
        capturedAt: CAPTURED_AT,
      });

      expect(
        (prisma.payments.updateMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where,
      ).toMatchObject({ business_id: BUSINESS_ID });
      expect(prisma.payments.findFirst).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID, business_id: BUSINESS_ID },
      });
    });

    it('throws when the payment is not visible to the business', async () => {
      prisma.payments.findFirst.mockResolvedValue(null);

      await expect(
        repository.claimPaymentSuccess(OTHER_BUSINESS_ID, PAYMENT_ID, {
          capturedAt: CAPTURED_AT,
        }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  // ─────────────────────────────────────────────
  // updatePaymentStatus
  // ─────────────────────────────────────────────

  describe('updatePaymentStatus', () => {
    it('throws when the payment is not visible to the business', async () => {
      prisma.payments.findFirst.mockResolvedValue(null);

      const error = await repository
        .updatePaymentStatus(OTHER_BUSINESS_ID, PAYMENT_ID, { status: 'SUCCESS' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      // The message stays tenant-agnostic — the discriminating detail is
      // log-only context, so a caller can't confirm the id exists elsewhere.
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect((error as ResourceNotFoundError).message).toBe('Payment not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Payment',
        resourceId: PAYMENT_ID,
        businessId: OTHER_BUSINESS_ID,
      });
      expect(prisma.payments.update).not.toHaveBeenCalled();
    });

    it('updates only the status when no optional field is supplied', async () => {
      prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });

      await repository.updatePaymentStatus(BUSINESS_ID, PAYMENT_ID, {
        status: 'FAILED',
      });

      expect(prisma.payments.update).toHaveBeenCalledWith({
        where: { id: PAYMENT_ID, business_id: BUSINESS_ID },
        data: { status: 'FAILED' },
      });
    });

    it('maps every supplied optional field onto its column', async () => {
      prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });
      const initiatedAt = new Date('2026-01-01T00:00:00.000Z');
      const capturedAt = new Date('2026-01-02T00:00:00.000Z');
      const failedAt = new Date('2026-01-03T00:00:00.000Z');

      await repository.updatePaymentStatus(BUSINESS_ID, PAYMENT_ID, {
        status: 'SUCCESS',
        method: 'UPI',
        gatewayPaymentId: 'pay_1',
        gatewaySignature: 'sig',
        gatewayResponse: { ok: true },
        initiatedAt,
        capturedAt,
        failedAt,
        failureReason: 'none',
      });

      expect(prisma.payments.update.mock.calls[0][0].data).toEqual({
        status: 'SUCCESS',
        method: 'UPI',
        gateway_payment_id: 'pay_1',
        gateway_signature: 'sig',
        gateway_response: { ok: true },
        initiated_at: initiatedAt,
        captured_at: capturedAt,
        failed_at: failedAt,
        failure_reason: 'none',
      });
    });

    it('treats explicit nulls as values to write, not as omissions', async () => {
      prisma.payments.findFirst.mockResolvedValue({ id: PAYMENT_ID });

      await repository.updatePaymentStatus(BUSINESS_ID, PAYMENT_ID, {
        status: 'PENDING',
        method: null,
        gatewayPaymentId: null,
        gatewaySignature: null,
        initiatedAt: null,
        capturedAt: null,
        failedAt: null,
        failureReason: null,
      });

      expect(prisma.payments.update.mock.calls[0][0].data).toEqual({
        status: 'PENDING',
        method: null,
        gateway_payment_id: null,
        gateway_signature: null,
        initiated_at: null,
        captured_at: null,
        failed_at: null,
        failure_reason: null,
      });
    });
  });

  // ─────────────────────────────────────────────
  // Refunds
  // ─────────────────────────────────────────────

  describe('sumCompletedRefundsForPayment', () => {
    it('returns 0 when no COMPLETED refunds exist', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: null } });

      await expect(
        repository.sumCompletedRefundsForPayment(BUSINESS_ID, PAYMENT_ID),
      ).resolves.toBe(0);
      expect(prisma.refunds.aggregate).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          payment_id: PAYMENT_ID,
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      });
    });

    it('converts the Decimal sum to a number', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(150.25) } });

      await expect(
        repository.sumCompletedRefundsForPayment(BUSINESS_ID, PAYMENT_ID),
      ).resolves.toBe(150.25);
    });
  });

  describe('sumCommittedRefundsForPayment', () => {
    it('counts in-flight refunds as well as settled ones, tenant-scoped', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(300) } });

      await expect(
        repository.sumCommittedRefundsForPayment(BUSINESS_ID, PAYMENT_ID),
      ).resolves.toBe(300);
      expect(prisma.refunds.aggregate).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          payment_id: PAYMENT_ID,
          status: { in: ['INITIATED', 'PROCESSING', 'COMPLETED'] },
        },
        _sum: { amount: true },
      });
    });

    it('returns 0 when the payment has never been refunded', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: null } });

      await expect(
        repository.sumCommittedRefundsForPayment(BUSINESS_ID, PAYMENT_ID),
      ).resolves.toBe(0);
    });

    it('excludes FAILED and REJECTED refunds, which moved no money', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(0) } });

      await repository.sumCommittedRefundsForPayment(BUSINESS_ID, PAYMENT_ID);

      const statuses = (
        prisma.refunds.aggregate.mock.calls[0]?.[0] as {
          where: { status: { in: string[] } };
        }
      ).where.status.in;
      expect(statuses).not.toContain('FAILED');
      expect(statuses).not.toContain('REJECTED');
    });
  });

  // ─────────────────────────────────────────────
  // reserveRefund
  //
  // Where the refundable-balance rule actually lives. Summing the committed
  // refunds and then inserting a row as two separate statements is
  // check-then-act on a total any concurrent caller can move: two ₹300 refunds
  // against one ₹500 payment both read `committed = 0`, both find the whole
  // balance free, and both insert.
  //
  // The gateway is not the backstop it looks like — it caps cumulative refunds
  // only on the paths that reach it. A COD payment has no gateway, and an
  // over-policy refund is recorded for approval without calling one, so on
  // exactly the refunds a person later pays out by hand there is nothing else
  // holding the line.
  // ─────────────────────────────────────────────

  describe('reserveRefund', () => {
    /** The SQL text of the lock statement, with its template holes closed up. */
    const lockSql = (): string => {
      const [strings] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      return Array.from(strings).join(' ').replace(/\s+/g, ' ');
    };

    const reserve = (amountPaise: number, extra: Record<string, unknown> = {}) =>
      repository.reserveRefund(BUSINESS_ID, PAYMENT_ID, { amountPaise, ...extra });

    it('locks the payment row before reading the committed total', async () => {
      await reserve(10000);

      // Without FOR UPDATE the sum is a plain read and two callers can pass it
      // at once — the entire failure this method exists to prevent.
      expect(lockSql()).toMatch(/FOR UPDATE/i);
      expect(lockSql()).toMatch(/FROM payments/i);
    });

    it('scopes the lock to the tenant as well as the payment id', async () => {
      await reserve(10000);

      const [, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...string[],
      ];
      expect(lockSql()).toMatch(/business_id/);
      expect(values).toContain(BUSINESS_ID);
      expect(values).toContain(PAYMENT_ID);
    });

    it('does the whole check inside one transaction', async () => {
      await reserve(10000);

      // A sum read outside the transaction is not covered by the lock, so the
      // insert could still race it.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.refunds.aggregate).toHaveBeenCalled();
      expect(prisma.refunds.create).toHaveBeenCalled();
    });

    it('grants a refund that fits the remaining balance and writes the row', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(300) } });

      const result = await reserve(20000, { reason: 'Balance', currency: 'INR' });

      expect(result.reserved).toBe(true);
      expect(result.refund).not.toBeNull();
      expect(result.originalAmountPaise).toBe(50000);
      expect(result.committedPaise).toBe(30000);
      expect(result.refundablePaise).toBe(20000);

      const { data } = prisma.refunds.create.mock.calls[0][0];
      expect(data.business_id).toBe(BUSINESS_ID);
      expect(data.payment_id).toBe(PAYMENT_ID);
      expect(data.status).toBe('INITIATED');
      expect(data.reason).toBe('Balance');
      // Rows are rupees; the caller works in paise.
      expect(Number(data.amount)).toBe(200);
    });

    it('refuses a refund past the remaining balance and writes nothing', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(300) } });

      const result = await reserve(30000);

      expect(result.reserved).toBe(false);
      expect(result.refund).toBeNull();
      expect(result.refundablePaise).toBe(20000);
      // The row is the reservation, so refusing must not create one.
      expect(prisma.refunds.create).not.toHaveBeenCalled();
    });

    it('allows a refund that exactly exhausts the balance', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(300) } });

      // An off-by-one here would refuse the last legitimate refund on every
      // partially refunded payment.
      const result = await reserve(20000);

      expect(result.reserved).toBe(true);
    });

    it('counts in-flight refunds against the balance, not just settled ones', async () => {
      await reserve(10000);

      const statuses = prisma.refunds.aggregate.mock.calls[0][0].where.status.in;
      // The money is already requested; waiting for COMPLETED would leave the
      // gap open for as long as the gateway takes to settle.
      expect(statuses).toEqual(
        expect.arrayContaining(['INITIATED', 'PROCESSING', 'COMPLETED']),
      );
      expect(statuses).not.toContain('FAILED');
      expect(statuses).not.toContain('REJECTED');
    });

    it('scopes the committed sum to the tenant and payment', async () => {
      await reserve(10000);

      const { where } = prisma.refunds.aggregate.mock.calls[0][0];
      expect(where.business_id).toBe(BUSINESS_ID);
      expect(where.payment_id).toBe(PAYMENT_ID);
    });

    it('treats a payment with no refunds yet as fully refundable', async () => {
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const result = await reserve(50000);

      expect(result.committedPaise).toBe(0);
      expect(result.refundablePaise).toBe(50000);
      expect(result.reserved).toBe(true);
    });

    it('clamps an over-committed balance to zero rather than going negative', async () => {
      // Drift past the original must not wrap into a negative ceiling, which
      // would compare as less than any request and let everything through.
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(600) } });

      const result = await reserve(1);

      expect(result.refundablePaise).toBe(0);
      expect(result.reserved).toBe(false);
    });

    it('carries the approval flag onto the reserved row', async () => {
      // An over-policy refund is reserved before anyone approves it — otherwise
      // two of them could each be approved against the same balance later.
      await reserve(10000, { requiresApproval: true });

      expect(prisma.refunds.create.mock.calls[0][0].data.requires_approval).toBe(true);
    });

    it('refuses to reserve against a payment the tenant does not own', async () => {
      // The locking SELECT is itself the tenant check: no row, no reservation.
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(reserve(10000)).rejects.toBeInstanceOf(ResourceNotFoundError);
      expect(prisma.refunds.create).not.toHaveBeenCalled();
    });
  });

  describe('createRefund', () => {
    const minimal = {
      businessId: BUSINESS_ID,
      paymentId: PAYMENT_ID,
      amountRupees: 99,
    };

    it('applies defaults for every omitted optional field', async () => {
      await repository.createRefund(minimal);

      const { data } = prisma.refunds.create.mock.calls[0][0];
      expect(data.status).toBe('INITIATED');
      expect(data.order_id).toBeNull();
      expect(data.currency).toBe('INR');
      expect(data.reason).toBeNull();
      expect(data.requires_approval).toBe(false);
      expect(data.gateway_refund_id).toBeNull();
      expect(data.gateway_response).toBe(Prisma.JsonNull);
      expect(Number(data.amount)).toBe(99);
    });

    it('passes through every supplied optional field', async () => {
      await repository.createRefund({
        ...minimal,
        orderId: ORDER_ID,
        currency: 'USD',
        reason: 'damaged',
        requiresApproval: true,
        gatewayRefundId: 'rfnd_1',
        gatewayResponse: { status: 'processed' },
      });

      const { data } = prisma.refunds.create.mock.calls[0][0];
      expect(data.order_id).toBe(ORDER_ID);
      expect(data.currency).toBe('USD');
      expect(data.reason).toBe('damaged');
      expect(data.requires_approval).toBe(true);
      expect(data.gateway_refund_id).toBe('rfnd_1');
      expect(data.gateway_response).toEqual({ status: 'processed' });
    });
  });

  describe('listRefunds', () => {
    it('defaults pagination and applies no optional filters', async () => {
      const result = await repository.listRefunds(BUSINESS_ID, {});

      expect(prisma.refunds.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { created_at: 'desc' },
        skip: 0,
        take: 20,
        include: { payment: true },
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('applies paymentId and orderId filters with explicit pagination', async () => {
      prisma.refunds.count.mockResolvedValue(7);

      const result = await repository.listRefunds(BUSINESS_ID, {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        page: 2,
        limit: 3,
      });

      expect(prisma.refunds.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          business_id: BUSINESS_ID,
          payment_id: PAYMENT_ID,
          order_id: ORDER_ID,
        },
        skip: 3,
        take: 3,
      });
      expect(result.totalPages).toBe(3);
    });
  });

  describe('updateRefundStatus', () => {
    it('throws when the refund is not visible to the business', async () => {
      prisma.refunds.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateRefundStatus(OTHER_BUSINESS_ID, REFUND_ID, { status: 'COMPLETED' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).message).toBe('Refund not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Refund',
        resourceId: REFUND_ID,
        businessId: OTHER_BUSINESS_ID,
      });
      expect(prisma.refunds.update).not.toHaveBeenCalled();
    });

    it('updates only the status when no optional field is supplied', async () => {
      prisma.refunds.findFirst.mockResolvedValue({ id: REFUND_ID });

      await repository.updateRefundStatus(BUSINESS_ID, REFUND_ID, { status: 'FAILED' });

      expect(prisma.refunds.update).toHaveBeenCalledWith({
        where: { id: REFUND_ID, business_id: BUSINESS_ID },
        data: { status: 'FAILED' },
      });
    });

    it('maps every supplied optional field onto its column', async () => {
      prisma.refunds.findFirst.mockResolvedValue({ id: REFUND_ID });
      const completedAt = new Date('2026-02-01T00:00:00.000Z');
      const failedAt = new Date('2026-02-02T00:00:00.000Z');
      const approvedAt = new Date('2026-02-03T00:00:00.000Z');
      const rejectedAt = new Date('2026-02-04T00:00:00.000Z');

      await repository.updateRefundStatus(BUSINESS_ID, REFUND_ID, {
        status: 'COMPLETED',
        gatewayRefundId: 'rfnd_1',
        gatewayResponse: { ok: true },
        completedAt,
        failedAt,
        approvedBy: 'user-1',
        approvedAt,
        rejectedBy: 'user-2',
        rejectedAt,
        rejectionReason: 'policy',
      });

      expect(prisma.refunds.update.mock.calls[0][0].data).toEqual({
        status: 'COMPLETED',
        gateway_refund_id: 'rfnd_1',
        gateway_response: { ok: true },
        completed_at: completedAt,
        failed_at: failedAt,
        approved_by: 'user-1',
        approved_at: approvedAt,
        rejected_by: 'user-2',
        rejected_at: rejectedAt,
        rejection_reason: 'policy',
      });
    });
  });

  // ─────────────────────────────────────────────
  // getPaymentSummaryForOrder
  // ─────────────────────────────────────────────

  describe('getPaymentSummaryForOrder', () => {
    it('returns all-zero totals and skips the refund query when the order has no payments', async () => {
      prisma.payments.findMany.mockResolvedValue([]);

      await expect(
        repository.getPaymentSummaryForOrder(BUSINESS_ID, ORDER_ID),
      ).resolves.toEqual({ paidRupees: 0, pendingRupees: 0, refundedRupees: 0 });
      expect(prisma.refunds.aggregate).not.toHaveBeenCalled();
    });

    it('buckets SUCCESS into paid and PENDING/INITIATED into pending', async () => {
      prisma.payments.findMany.mockResolvedValue([
        { id: 'p1', status: 'SUCCESS', amount: decimal(100) },
        { id: 'p2', status: 'PENDING', amount: decimal(50) },
        { id: 'p3', status: 'INITIATED', amount: decimal(25) },
        { id: 'p4', status: 'FAILED', amount: decimal(999) },
      ]);
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: decimal(30) } });

      const summary = await repository.getPaymentSummaryForOrder(BUSINESS_ID, ORDER_ID);

      expect(summary).toEqual({
        paidRupees: 100,
        pendingRupees: 75,
        refundedRupees: 30,
      });
      expect(prisma.refunds.aggregate).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          payment_id: { in: ['p1', 'p2', 'p3', 'p4'] },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      });
    });

    it('treats a null refund aggregate as zero refunded', async () => {
      prisma.payments.findMany.mockResolvedValue([
        { id: 'p1', status: 'SUCCESS', amount: decimal(10) },
      ]);
      prisma.refunds.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const summary = await repository.getPaymentSummaryForOrder(BUSINESS_ID, ORDER_ID);

      expect(summary.refundedRupees).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // Webhook idempotency
  // ─────────────────────────────────────────────

  describe('recordWebhookEvent', () => {
    const base = {
      source: 'razorpay',
      eventType: 'payment.captured',
      externalId: 'evt_1',
      payload: { a: 1 },
      headers: { 'x-signature': 'sig' },
      signatureValid: true,
    };

    it('stores a null business_id when the event is not yet attributed', async () => {
      await expect(repository.recordWebhookEvent(base)).resolves.toEqual({ id: 'wh-1' });

      expect(prisma.webhook_events.create.mock.calls[0][0].data.business_id).toBeNull();
    });

    it('stores the business_id when supplied', async () => {
      await repository.recordWebhookEvent({ ...base, businessId: BUSINESS_ID });

      expect(prisma.webhook_events.create.mock.calls[0][0].data).toMatchObject({
        business_id: BUSINESS_ID,
        source: 'razorpay',
        event_type: 'payment.captured',
        external_id: 'evt_1',
        signature_valid: true,
      });
    });

    it('returns null on a duplicate delivery (P2002)', async () => {
      prisma.webhook_events.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
      );

      await expect(repository.recordWebhookEvent(base)).resolves.toBeNull();
    });

    it('rethrows a known Prisma error that is not a unique violation', async () => {
      prisma.webhook_events.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: '5.0.0',
        }),
      );

      await expect(repository.recordWebhookEvent(base)).rejects.toThrow('fk');
    });

    it('rethrows non-Prisma errors', async () => {
      prisma.webhook_events.create.mockRejectedValue(new Error('connection reset'));

      await expect(repository.recordWebhookEvent(base)).rejects.toThrow('connection reset');
    });
  });

  it('marks a webhook event processed with a timestamp', async () => {
    await repository.markWebhookProcessed('wh-1');

    const call = prisma.webhook_events.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'wh-1' });
    expect(call.data.processed).toBe(true);
    expect(call.data.processed_at).toBeInstanceOf(Date);
  });

  // ─────────────────────────────────────────────
  // Reconciliation
  // ─────────────────────────────────────────────

  describe('listReconcilablePayments', () => {
    it('defaults to a limit of 100 and matches link OR order ids', async () => {
      await repository.listReconcilablePayments(BUSINESS_ID);

      expect(prisma.payments.findMany).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          status: { in: ['PENDING', 'INITIATED'] },
          OR: [
            { payment_link_id: { not: null } },
            { gateway_order_id: { not: null } },
          ],
        },
        orderBy: { created_at: 'asc' },
        take: 100,
      });
    });

    it('honours an explicit limit', async () => {
      await repository.listReconcilablePayments(BUSINESS_ID, 5);

      expect(prisma.payments.findMany.mock.calls[0][0].take).toBe(5);
    });
  });

  // ─────────────────────────────────────────────
  // Invoices
  // ─────────────────────────────────────────────

  describe('createInvoice', () => {
    const minimal = {
      businessId: BUSINESS_ID,
      clientId: CLIENT_ID,
      invoiceNumber: 'INV-2026-000001',
      subtotal: 1000,
      total: 1180,
      lineItems: [
        { description: 'Consult', quantity: 1, unitAmountMinor: 100000, amountMinor: 100000 },
      ],
    };

    it('applies defaults for every omitted optional field', async () => {
      await repository.createInvoice(minimal);

      const { data } = prisma.invoices.create.mock.calls[0][0];
      expect(data.status).toBe('DRAFT');
      expect(data.order_id).toBeNull();
      expect(data.payment_id).toBeNull();
      expect(data.currency).toBe('INR');
      expect(Number(data.tax_amount)).toBe(0);
      expect(Number(data.discount_amount)).toBe(0);
      expect(data.notes).toBeNull();
      expect(data.due_at).toBeNull();
      expect(Number(data.subtotal)).toBe(1000);
      expect(Number(data.total)).toBe(1180);
    });

    it('passes through every supplied optional field', async () => {
      const dueAt = new Date('2026-03-01T00:00:00.000Z');

      await repository.createInvoice({
        ...minimal,
        orderId: ORDER_ID,
        paymentId: PAYMENT_ID,
        currency: 'USD',
        taxAmount: 180,
        discountAmount: 20,
        notes: 'net 30',
        dueAt,
      });

      const { data } = prisma.invoices.create.mock.calls[0][0];
      expect(data.order_id).toBe(ORDER_ID);
      expect(data.payment_id).toBe(PAYMENT_ID);
      expect(data.currency).toBe('USD');
      expect(Number(data.tax_amount)).toBe(180);
      expect(Number(data.discount_amount)).toBe(20);
      expect(data.notes).toBe('net 30');
      expect(data.due_at).toBe(dueAt);
    });
  });

  describe('invoice lookups', () => {
    it('excludes soft-deleted invoices when fetching by id', async () => {
      prisma.invoices.findFirst.mockResolvedValue({ id: INVOICE_ID });

      await repository.getInvoice(BUSINESS_ID, INVOICE_ID);

      expect(prisma.invoices.findFirst).toHaveBeenCalledWith({
        where: { id: INVOICE_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });

    it('excludes soft-deleted invoices when fetching by payment id', async () => {
      prisma.invoices.findFirst.mockResolvedValue(null);

      await expect(repository.findInvoiceByPaymentId(PAYMENT_ID)).resolves.toBeNull();
      expect(prisma.invoices.findFirst).toHaveBeenCalledWith({
        where: { payment_id: PAYMENT_ID, deleted_at: null },
      });
    });
  });

  describe('listInvoices', () => {
    it('defaults pagination and excludes soft-deleted rows', async () => {
      const result = await repository.listInvoices(BUSINESS_ID, {});

      expect(prisma.invoices.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result.page).toBe(1);
    });

    it('applies every optional filter', async () => {
      prisma.invoices.count.mockResolvedValue(4);

      const result = await repository.listInvoices(BUSINESS_ID, {
        status: 'ISSUED',
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        page: 2,
        limit: 2,
      });

      expect(prisma.invoices.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          business_id: BUSINESS_ID,
          deleted_at: null,
          status: 'ISSUED',
          order_id: ORDER_ID,
          client_id: CLIENT_ID,
        },
        skip: 2,
        take: 2,
      });
      expect(result.totalPages).toBe(2);
    });
  });

  describe('updateInvoiceStatus', () => {
    it('throws when the invoice is not visible to the business', async () => {
      prisma.invoices.findFirst.mockResolvedValue(null);

      const error = await repository
        .updateInvoiceStatus(OTHER_BUSINESS_ID, INVOICE_ID, { status: 'PAID' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).message).toBe('Invoice not found');
      expect((error as ResourceNotFoundError).context).toEqual({
        resource: 'Invoice',
        resourceId: INVOICE_ID,
        businessId: OTHER_BUSINESS_ID,
      });
      expect(prisma.invoices.update).not.toHaveBeenCalled();
    });

    it('updates only the status when no timestamp is supplied', async () => {
      prisma.invoices.findFirst.mockResolvedValue({ id: INVOICE_ID });

      await repository.updateInvoiceStatus(BUSINESS_ID, INVOICE_ID, { status: 'VOID' });

      expect(prisma.invoices.update).toHaveBeenCalledWith({
        where: { id: INVOICE_ID, business_id: BUSINESS_ID },
        data: { status: 'VOID' },
      });
    });

    it('maps issuedAt, paidAt and paymentId onto their columns', async () => {
      prisma.invoices.findFirst.mockResolvedValue({ id: INVOICE_ID });
      const issuedAt = new Date('2026-04-01T00:00:00.000Z');
      const paidAt = new Date('2026-04-02T00:00:00.000Z');

      await repository.updateInvoiceStatus(BUSINESS_ID, INVOICE_ID, {
        status: 'PAID',
        issuedAt,
        paidAt,
        paymentId: PAYMENT_ID,
      });

      expect(prisma.invoices.update.mock.calls[0][0].data).toEqual({
        status: 'PAID',
        issued_at: issuedAt,
        paid_at: paidAt,
        payment_id: PAYMENT_ID,
      });
    });
  });

  describe('countInvoicesForYear', () => {
    it('bounds the count to the requested UTC calendar year', async () => {
      prisma.invoices.count.mockResolvedValue(41);

      await expect(repository.countInvoicesForYear(BUSINESS_ID, 2026)).resolves.toBe(41);
      expect(prisma.invoices.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          created_at: {
            gte: new Date(Date.UTC(2026, 0, 1)),
            lt: new Date(Date.UTC(2027, 0, 1)),
          },
        },
      });
    });
  });

  describe('findHighestInvoiceSequenceForYear', () => {
    const latest = (n: string | null) =>
      prisma.invoices.findFirst.mockResolvedValue(n ? { invoice_number: n } : null);

    it('reports zero when the business has issued none this year', async () => {
      latest(null);

      await expect(
        repository.findHighestInvoiceSequenceForYear(BUSINESS_ID, 2026),
      ).resolves.toBe(0);
    });

    it('parses the sequence out of the highest number issued', async () => {
      latest('INV-2026-000041');

      await expect(
        repository.findHighestInvoiceSequenceForYear(BUSINESS_ID, 2026),
      ).resolves.toBe(41);
    });

    it('seeks by the number itself, not by created_at', async () => {
      // Numbering by a created_at count disagrees with the year encoded in the
      // number at the new-year boundary: an invoice created moments into
      // January is counted into the new year and numbered into it too, while
      // one created moments before is counted into the old year — so the two
      // sequences can hand out the same number.
      latest(null);

      await repository.findHighestInvoiceSequenceForYear(BUSINESS_ID, 2026);

      expect(prisma.invoices.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          invoice_number: { startsWith: 'INV-2026-' },
        },
        orderBy: { invoice_number: 'desc' },
        select: { invoice_number: true },
      });
    });

    it('scopes to the tenant, so another business’s invoices cannot shift the sequence', async () => {
      latest('INV-2026-000900');

      await repository.findHighestInvoiceSequenceForYear(BUSINESS_ID, 2026);

      expect(prisma.invoices.findFirst.mock.calls[0][0].where.business_id).toBe(BUSINESS_ID);
    });

    it('falls back to zero on an unparseable stored number rather than NaN', async () => {
      // `NaN + 1` would render as "INV-2026-000NaN" and then collide forever.
      latest('INV-2026-legacy');

      await expect(
        repository.findHighestInvoiceSequenceForYear(BUSINESS_ID, 2026),
      ).resolves.toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // getPaymentStats date-window branches
  // ─────────────────────────────────────────────

  describe('getPaymentStats date filtering', () => {
    it('omits the created_at filter entirely when no window is given', async () => {
      await repository.getPaymentStats(BUSINESS_ID, {});

      expect(prisma.payments.groupBy.mock.calls[0][0].where).toEqual({
        business_id: BUSINESS_ID,
      });
    });

    it('applies a lower bound only', async () => {
      await repository.getPaymentStats(BUSINESS_ID, { from: '2026-01-01' });

      expect(prisma.payments.groupBy.mock.calls[0][0].where.created_at).toEqual({
        gte: new Date('2026-01-01'),
      });
    });

    it('applies an upper bound only', async () => {
      await repository.getPaymentStats(BUSINESS_ID, { to: '2026-02-01' });

      expect(prisma.payments.groupBy.mock.calls[0][0].where.created_at).toEqual({
        lte: new Date('2026-02-01'),
      });
    });

    it('applies both bounds', async () => {
      await repository.getPaymentStats(BUSINESS_ID, {
        from: '2026-01-01',
        to: '2026-02-01',
      });

      expect(prisma.payments.groupBy.mock.calls[0][0].where.created_at).toEqual({
        gte: new Date('2026-01-01'),
        lte: new Date('2026-02-01'),
      });
    });
  });
});
