import { PaymentRepository } from './payment.repository';

/**
 * Tests for PaymentRepository.getPaymentStats, exercised against the real
 * repository implementation. `payments.amount` / `refunds.amount` are
 * Decimal(14,2) rupee columns — there is no `amount_paise` column on either
 * table, so every mock row here mimics a Prisma Decimal (toString() only,
 * matching how `Number(decimal)` actually resolves it at runtime).
 */
describe('PaymentRepository.getPaymentStats', () => {
  let prisma: {
    payments: { findMany: jest.Mock };
    refunds: { findMany: jest.Mock };
  };
  let repository: PaymentRepository;

  const decimal = (rupees: number) => ({ toString: () => rupees.toFixed(2) });

  beforeEach(() => {
    prisma = {
      payments: { findMany: jest.fn() },
      refunds: { findMany: jest.fn() },
    };
    repository = new PaymentRepository(prisma as never);
  });

  it('should return zero stats for no payments', async () => {
    prisma.payments.findMany.mockResolvedValue([]);

    const stats = await repository.getPaymentStats('biz-1', {});

    expect(stats.totalRevenue).toBe(0);
    expect(stats.totalTransactions).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.avgTransactionValue).toBe(0);
    expect(stats.refundedAmount).toBe(0);
    expect(stats.refundCount).toBe(0);
    expect(prisma.refunds.findMany).not.toHaveBeenCalled();
  });

  it('should calculate revenue in paise from SUCCESS payments only', async () => {
    prisma.payments.findMany.mockResolvedValue([
      { id: 'p1', status: 'SUCCESS', amount: decimal(100) },
      { id: 'p2', status: 'SUCCESS', amount: decimal(200) },
      { id: 'p3', status: 'FAILED', amount: decimal(50) },
    ]);
    prisma.refunds.findMany.mockResolvedValue([]);

    const stats = await repository.getPaymentStats('biz-1', {});

    expect(stats.totalRevenue).toBe(30000); // paise
    expect(stats.totalTransactions).toBe(3);
    expect(stats.avgTransactionValue).toBe(15000);
    // 2 successful / 3 total = 0.67
    expect(stats.successRate).toBe(0.67);
  });

  it('should sum refunded amounts from the refunds table, not the payment row', async () => {
    prisma.payments.findMany.mockResolvedValue([
      { id: 'p1', status: 'SUCCESS', amount: decimal(500) },
      { id: 'p2', status: 'REFUNDED', amount: decimal(200) },
      { id: 'p3', status: 'PARTIALLY_REFUNDED', amount: decimal(300) },
    ]);
    prisma.refunds.findMany.mockResolvedValue([
      { amount: decimal(200) },
      { amount: decimal(100) },
    ]);

    const stats = await repository.getPaymentStats('biz-1', {});

    // Only the SUCCESS payment counts toward revenue.
    expect(stats.totalRevenue).toBe(50000);
    expect(stats.refundedAmount).toBe(30000);
    expect(stats.refundCount).toBe(2);
    expect(prisma.refunds.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          business_id: 'biz-1',
          payment_id: { in: ['p1', 'p2', 'p3'] },
          status: 'COMPLETED',
        }),
      }),
    );
  });

  it('should apply date filters to the payments query', async () => {
    prisma.payments.findMany.mockResolvedValue([]);

    await repository.getPaymentStats('biz-1', { from: '2024-01-01', to: '2024-12-31' });

    expect(prisma.payments.findMany).toHaveBeenCalledWith({
      where: {
        business_id: 'biz-1',
        created_at: {
          gte: new Date('2024-01-01'),
          lte: new Date('2024-12-31'),
        },
      },
      select: { id: true, status: true, amount: true },
    });
  });
});
