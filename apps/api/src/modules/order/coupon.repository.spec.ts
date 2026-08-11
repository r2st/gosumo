/**
 * CouponRepository unit tests.
 *
 * `coupon.spec.ts` and `coupon.branches.spec.ts` both mock this repository, so
 * the query construction itself had almost no coverage. Two parts carry real
 * risk and both are branch-heavy:
 *
 *   - **`update`'s all-optional patch.** Each field is guarded on
 *     `!== undefined` rather than truthiness, which is the only thing keeping a
 *     PATCH that explicitly clears `maxDiscount` to `null` distinguishable from
 *     one that never mentioned it. A regression to `if (data.maxDiscount)`
 *     would silently ignore both the clear *and* a legitimate 0.
 *   - **`list`'s optional `isActive` filter,** which must be absent from the
 *     `where` when not supplied — an `is_active: undefined` key reads fine but
 *     a `false` default would hide every live coupon.
 *
 * Root rule #1 is asserted throughout: every query carries `business_id`.
 * Root rule #5: deletion is a soft delete, never a row removal.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DiscountType } from '@gosumo/shared';

import { CouponRepository, type CreateCouponData } from './coupon.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const COUPON_ID = '00000000-0000-4000-b000-000000000001';
const CLIENT_ID = '00000000-0000-4000-c000-000000000001';

function couponData(overrides: Partial<CreateCouponData> = {}): CreateCouponData {
  return {
    businessId: BUSINESS_ID,
    code: 'DIWALI20',
    type: DiscountType.PERCENT,
    value: 20,
    ...overrides,
  };
}

describe('CouponRepository', () => {
  let repository: CouponRepository;
  let prisma: {
    coupons: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    orders: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      coupons: {
        create: jest.fn().mockResolvedValue({ id: COUPON_ID }),
        findFirst: jest.fn().mockResolvedValue({ id: COUPON_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({ id: COUPON_ID }),
      },
      orders: { count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get<CouponRepository>(CouponRepository);
  });

  /** The row Prisma was asked to insert. */
  function createdRow(): Record<string, unknown> {
    return prisma.coupons.create.mock.calls[0]![0].data;
  }

  /** The `data` patch handed to `coupons.update`. */
  function updatedData(): Record<string, unknown> {
    return prisma.coupons.update.mock.calls[0]![0].data;
  }

  /** The `where` handed to `coupons.update`. */
  function updatedWhere(): Record<string, unknown> {
    return prisma.coupons.update.mock.calls[0]![0].where;
  }

  // ─────────────────────────────────────────────
  // create
  // ─────────────────────────────────────────────

  describe('create', () => {
    it('persists the tenant scope and the required fields', async () => {
      await repository.create(couponData());

      expect(createdRow()).toMatchObject({
        business_id: BUSINESS_ID,
        code: 'DIWALI20',
        value: 20,
      });
    });

    it('nulls every omitted optional field rather than leaving it undefined', async () => {
      await repository.create(couponData());

      expect(createdRow()).toMatchObject({
        description: null,
        min_order_value: null,
        max_discount: null,
        usage_limit: null,
        per_client_limit: null,
        valid_from: null,
        valid_until: null,
      });
    });

    it('passes through every supplied optional field', async () => {
      const from = new Date('2026-10-01T00:00:00Z');
      const until = new Date('2026-11-01T00:00:00Z');

      await repository.create(
        couponData({
          description: 'Festive offer',
          minOrderValue: 500,
          maxDiscount: 200,
          usageLimit: 100,
          perClientLimit: 1,
          validFrom: from,
          validUntil: until,
        }),
      );

      expect(createdRow()).toMatchObject({
        description: 'Festive offer',
        min_order_value: 500,
        max_discount: 200,
        usage_limit: 100,
        per_client_limit: 1,
        valid_from: from,
        valid_until: until,
      });
    });
  });

  // ─────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────

  describe('findByCode', () => {
    it('scopes to the tenant, matches case-insensitively and excludes soft-deleted rows', async () => {
      await repository.findByCode(BUSINESS_ID, 'diwali20');

      expect(prisma.coupons.findFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          code: { equals: 'diwali20', mode: 'insensitive' },
          deleted_at: null,
        },
      });
    });
  });

  describe('findById', () => {
    it('scopes to the tenant and excludes soft-deleted rows', async () => {
      await repository.findById(BUSINESS_ID, COUPON_ID);

      expect(prisma.coupons.findFirst.mock.calls[0]![0].where).toMatchObject({
        id: COUPON_ID,
        business_id: BUSINESS_ID,
        deleted_at: null,
      });
    });
  });

  // ─────────────────────────────────────────────
  // list
  // ─────────────────────────────────────────────

  describe('list', () => {
    /** The `where` handed to `coupons.findMany`. */
    function listedWhere(): Record<string, unknown> {
      return prisma.coupons.findMany.mock.calls[0]![0].where;
    }

    it('defaults to page 1 with a limit of 20', async () => {
      prisma.coupons.count.mockResolvedValue(45);

      const result = await repository.list(BUSINESS_ID, {});

      expect(prisma.coupons.findMany.mock.calls[0]![0]).toMatchObject({ skip: 0, take: 20 });
      expect(result).toMatchObject({ page: 1, limit: 20, total: 45, totalPages: 3 });
    });

    it('computes skip from the requested page', async () => {
      await repository.list(BUSINESS_ID, { page: 3, limit: 10 });

      expect(prisma.coupons.findMany.mock.calls[0]![0]).toMatchObject({ skip: 20, take: 10 });
    });

    it('omits the is_active filter entirely when not supplied', async () => {
      await repository.list(BUSINESS_ID, {});

      expect(listedWhere()).not.toHaveProperty('is_active');
      expect(listedWhere()).toMatchObject({ business_id: BUSINESS_ID, deleted_at: null });
    });

    it('applies is_active: false, not just the truthy case', async () => {
      // Guarded on `!== undefined`; a truthiness check would make "show me the
      // disabled coupons" silently return the active ones.
      await repository.list(BUSINESS_ID, { isActive: false });

      expect(listedWhere()).toMatchObject({ is_active: false });
    });

    it('applies is_active: true', async () => {
      await repository.list(BUSINESS_ID, { isActive: true });

      expect(listedWhere()).toMatchObject({ is_active: true });
    });

    it('counts under the same where clause it lists under', async () => {
      await repository.list(BUSINESS_ID, { isActive: true });

      expect(prisma.coupons.count.mock.calls[0]![0].where).toEqual(listedWhere());
    });

    it('reports zero pages for an empty result rather than one', async () => {
      prisma.coupons.count.mockResolvedValue(0);

      expect(await repository.list(BUSINESS_ID, {})).toMatchObject({ total: 0, totalPages: 0 });
    });
  });

  // ─────────────────────────────────────────────
  // update
  // ─────────────────────────────────────────────

  describe('update', () => {
    it('scopes the write to the tenant', async () => {
      await repository.update(BUSINESS_ID, COUPON_ID, { isActive: false });

      expect(updatedWhere()).toEqual({ id: COUPON_ID, business_id: BUSINESS_ID });
    });

    it('sends an empty patch when nothing was supplied', async () => {
      await repository.update(BUSINESS_ID, COUPON_ID, {});

      expect(updatedData()).toEqual({});
    });

    it('maps every supplied field to its column', async () => {
      const from = new Date('2026-10-01T00:00:00Z');
      const until = new Date('2026-11-01T00:00:00Z');

      await repository.update(BUSINESS_ID, COUPON_ID, {
        description: 'Updated',
        type: DiscountType.FIXED,
        value: 150,
        minOrderValue: 1000,
        maxDiscount: 300,
        usageLimit: 50,
        perClientLimit: 2,
        validFrom: from,
        validUntil: until,
        isActive: true,
      });

      expect(updatedData()).toEqual({
        description: 'Updated',
        type: DiscountType.FIXED,
        value: 150,
        min_order_value: 1000,
        max_discount: 300,
        usage_limit: 50,
        per_client_limit: 2,
        valid_from: from,
        valid_until: until,
        is_active: true,
      });
    });

    it('patches only the fields it was given', async () => {
      await repository.update(BUSINESS_ID, COUPON_ID, { value: 25 });

      expect(updatedData()).toEqual({ value: 25 });
    });

    it('writes an explicit null through rather than dropping it', async () => {
      // Clearing a cap is a real operation. `if (data.maxDiscount)` would drop
      // it and leave the old cap in place.
      await repository.update(BUSINESS_ID, COUPON_ID, {
        minOrderValue: null,
        maxDiscount: null,
        usageLimit: null,
        perClientLimit: null,
        validFrom: null,
        validUntil: null,
      });

      expect(updatedData()).toEqual({
        min_order_value: null,
        max_discount: null,
        usage_limit: null,
        per_client_limit: null,
        valid_from: null,
        valid_until: null,
      });
    });

    it('writes a zero value through rather than treating it as absent', async () => {
      await repository.update(BUSINESS_ID, COUPON_ID, {
        value: 0,
        minOrderValue: 0,
        maxDiscount: 0,
        usageLimit: 0,
        perClientLimit: 0,
      });

      expect(updatedData()).toEqual({
        value: 0,
        min_order_value: 0,
        max_discount: 0,
        usage_limit: 0,
        per_client_limit: 0,
      });
    });

    it('writes an empty description through', async () => {
      await repository.update(BUSINESS_ID, COUPON_ID, { description: '' });

      expect(updatedData()).toEqual({ description: '' });
    });
  });

  // ─────────────────────────────────────────────
  // softDelete / incrementUsage / countClientRedemptions
  // ─────────────────────────────────────────────

  describe('softDelete', () => {
    it('stamps deleted_at and deactivates instead of removing the row', async () => {
      await repository.softDelete(BUSINESS_ID, COUPON_ID);

      expect(updatedWhere()).toEqual({ id: COUPON_ID, business_id: BUSINESS_ID });
      expect(updatedData()).toMatchObject({ is_active: false });
      expect(updatedData().deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('incrementUsage', () => {
    it('increments atomically under the tenant scope', async () => {
      await repository.incrementUsage(BUSINESS_ID, COUPON_ID);

      expect(updatedWhere()).toEqual({ id: COUPON_ID, business_id: BUSINESS_ID });
      expect(updatedData()).toEqual({ usage_count: { increment: 1 } });
    });
  });

  describe('countClientRedemptions', () => {
    it('counts this client\'s non-cancelled orders on the code, case-insensitively', async () => {
      prisma.orders.count.mockResolvedValue(2);

      const count = await repository.countClientRedemptions(BUSINESS_ID, CLIENT_ID, 'diwali20');

      expect(count).toBe(2);
      expect(prisma.orders.count).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          client_id: CLIENT_ID,
          discount_code: { equals: 'diwali20', mode: 'insensitive' },
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
          deleted_at: null,
        },
      });
    });

    it('excludes cancelled and refunded orders so a refund frees the redemption', async () => {
      await repository.countClientRedemptions(BUSINESS_ID, CLIENT_ID, 'DIWALI20');

      const where = prisma.orders.count.mock.calls[0]![0].where;
      expect(where.status).toEqual({ notIn: ['CANCELLED', 'REFUNDED'] });
    });
  });
});
