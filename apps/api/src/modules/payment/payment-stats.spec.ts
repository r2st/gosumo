import { PaymentRepository } from './payment.repository';

/**
 * Tests for PaymentRepository.getPaymentStats, exercised against the real
 * repository implementation.
 *
 * The stats are computed by the database (`groupBy` over payments, `aggregate`
 * over refunds) rather than by reading rows and reducing them in JS, so the
 * mocks here return aggregate shapes. `payments.amount` / `refunds.amount` are
 * Decimal(14,2) rupee columns — there is no `amount_paise` column on either
 * table, so every summed amount mimics a Prisma Decimal (toString() only,
 * matching how `Number(decimal)` actually resolves it at runtime).
 */
describe('PaymentRepository.getPaymentStats', () => {
  let prisma: {
    payments: { groupBy: jest.Mock };
    refunds: { aggregate: jest.Mock };
  };
  let repository: PaymentRepository;

  const decimal = (rupees: number) => ({ toString: () => rupees.toFixed(2) });

  const noRefunds = { _count: { _all: 0 }, _sum: { amount: null } };

  beforeEach(() => {
    prisma = {
      payments: { groupBy: jest.fn().mockResolvedValue([]) },
      refunds: { aggregate: jest.fn().mockResolvedValue(noRefunds) },
    };
    repository = new PaymentRepository(prisma as never);
  });

  it('should return zero stats for no payments', async () => {
    const stats = await repository.getPaymentStats('biz-1', {});

    expect(stats.totalRevenue).toBe(0);
    expect(stats.totalTransactions).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.avgTransactionValue).toBe(0);
    expect(stats.refundedAmount).toBe(0);
    expect(stats.refundCount).toBe(0);
  });

  it('should calculate revenue in paise from SUCCESS payments only', async () => {
    prisma.payments.groupBy.mockResolvedValue([
      { status: 'SUCCESS', _count: { _all: 2 }, _sum: { amount: decimal(300) } },
      { status: 'FAILED', _count: { _all: 1 }, _sum: { amount: decimal(50) } },
    ]);

    const stats = await repository.getPaymentStats('biz-1', {});

    expect(stats.totalRevenue).toBe(30000); // paise
    expect(stats.totalTransactions).toBe(3);
    expect(stats.avgTransactionValue).toBe(15000);
    // 2 successful / 3 total = 0.67
    expect(stats.successRate).toBe(0.67);
  });

  it('should report zero revenue when no payment ever succeeded', async () => {
    prisma.payments.groupBy.mockResolvedValue([
      { status: 'FAILED', _count: { _all: 4 }, _sum: { amount: decimal(800) } },
    ]);

    const stats = await repository.getPaymentStats('biz-1', {});

    expect(stats.totalRevenue).toBe(0);
    expect(stats.totalTransactions).toBe(4);
    expect(stats.successRate).toBe(0);
    expect(stats.avgTransactionValue).toBe(0);
  });

  it('should sum refunded amounts from the refunds table, not the payment row', async () => {
    prisma.payments.groupBy.mockResolvedValue([
      { status: 'SUCCESS', _count: { _all: 1 }, _sum: { amount: decimal(500) } },
      { status: 'REFUNDED', _count: { _all: 1 }, _sum: { amount: decimal(200) } },
      {
        status: 'PARTIALLY_REFUNDED',
        _count: { _all: 1 },
        _sum: { amount: decimal(300) },
      },
    ]);
    prisma.refunds.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: { amount: decimal(300) },
    });

    const stats = await repository.getPaymentStats('biz-1', {});

    // Only the SUCCESS payment counts toward revenue.
    expect(stats.totalRevenue).toBe(50000);
    expect(stats.refundedAmount).toBe(30000);
    expect(stats.refundCount).toBe(2);
  });

  it('should scope refunds through the payment relation rather than an id list', async () => {
    await repository.getPaymentStats('biz-1', {
      from: '2024-01-01',
      to: '2024-12-31',
    });

    const paymentsWhere = {
      business_id: 'biz-1',
      created_at: {
        gte: new Date('2024-01-01'),
        lte: new Date('2024-12-31'),
      },
    };

    expect(prisma.refunds.aggregate).toHaveBeenCalledWith({
      where: {
        business_id: 'biz-1',
        status: 'COMPLETED',
        // The same window the payments query uses, reached through the
        // relation — never a materialised list of payment ids.
        payment: paymentsWhere,
      },
      _count: { _all: true },
      _sum: { amount: true },
    });
    expect(
      JSON.stringify(prisma.refunds.aggregate.mock.calls[0]?.[0]),
    ).not.toContain('payment_id');
  });

  it('should aggregate in the database rather than reading payment rows', async () => {
    await repository.getPaymentStats('biz-1', {});

    expect(prisma.payments.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['status'],
        _count: { _all: true },
        _sum: { amount: true },
      }),
    );
  });

  it('should apply date filters to the payments query', async () => {
    await repository.getPaymentStats('biz-1', {
      from: '2024-01-01',
      to: '2024-12-31',
    });

    expect(prisma.payments.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: {
        business_id: 'biz-1',
        created_at: {
          gte: new Date('2024-01-01'),
          lte: new Date('2024-12-31'),
        },
      },
      _count: { _all: true },
      _sum: { amount: true },
    });
  });
});
