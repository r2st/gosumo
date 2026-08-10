/**
 * CouponService — branch coverage for the CRUD surface.
 *
 * `coupon.spec.ts` covers creation guards and the discount math. What is left
 * is the update/list/read path, where two things carry real risk:
 *
 *  - **`updateCoupon`'s PERCENT ceiling.** The check runs against
 *    `dto.type ?? coupon.type`, so a PATCH that raises `value` past 100
 *    without restating `type` must still be rejected against the *stored*
 *    type — and a PATCH that switches an over-100 FIXED coupon to PERCENT
 *    must be rejected too. Both directions are the reason the effective-type
 *    fallback exists.
 *  - **`toCouponDto`'s money conversion.** `min_order_value` / `max_discount`
 *    are nullable rupee decimals converted to paise; a null must survive as
 *    null rather than becoming 0, which would silently impose a floor of zero
 *    (harmless) or a discount cap of zero (not harmless).
 *
 * The repository is mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CouponService } from './coupon.service';
import { CouponRepository } from './coupon.repository';
import { DiscountType } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const COUPON_ID = '00000000-0000-4000-8000-000000000010';
const CREATED_AT = new Date('2026-01-01T00:00:00Z');

function createMockCoupon(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: COUPON_ID,
    business_id: BUSINESS_ID,
    code: 'DIWALI20',
    description: null,
    type: DiscountType.PERCENT,
    value: 20,
    min_order_value: null,
    max_discount: null,
    usage_limit: null,
    per_client_limit: null,
    usage_count: 0,
    valid_from: null,
    valid_until: null,
    is_active: true,
    metadata: {},
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    deleted_at: null,
    ...overrides,
  };
}

describe('CouponService (CRUD branches)', () => {
  let service: CouponService;
  let repository: jest.Mocked<CouponRepository>;

  beforeEach(async () => {
    const mockRepository: jest.Mocked<Partial<CouponRepository>> = {
      create: jest.fn(),
      findByCode: jest.fn(),
      findById: jest.fn().mockResolvedValue(createMockCoupon()),
      list: jest.fn(),
      update: jest.fn().mockResolvedValue(createMockCoupon()),
      softDelete: jest.fn().mockResolvedValue(createMockCoupon({ is_active: false })),
      incrementUsage: jest.fn(),
      countClientRedemptions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponService, { provide: CouponRepository, useValue: mockRepository }],
    }).compile();

    service = module.get<CouponService>(CouponService);
    repository = module.get(CouponRepository) as jest.Mocked<CouponRepository>;
  });

  // ─────────────────────────────────────────────
  // DTO mapping
  // ─────────────────────────────────────────────

  describe('coupon DTO mapping', () => {
    it('keeps a null money field null rather than converting it to zero', async () => {
      // A maxDiscountPaise of 0 would cap every discount at nothing.
      repository.findById.mockResolvedValue(
        createMockCoupon({ min_order_value: null, max_discount: null }) as never,
      );

      const coupon = await service.getCoupon(BUSINESS_ID, COUPON_ID);

      expect(coupon.minOrderValuePaise).toBeNull();
      expect(coupon.maxDiscountPaise).toBeNull();
    });

    it('converts rupee money columns to paise', async () => {
      repository.findById.mockResolvedValue(
        createMockCoupon({ min_order_value: 500, max_discount: 250 }) as never,
      );

      const coupon = await service.getCoupon(BUSINESS_ID, COUPON_ID);

      expect(coupon.minOrderValuePaise).toBe(50000);
      expect(coupon.maxDiscountPaise).toBe(25000);
    });

    it('keeps a zero money column as zero paise, not null', async () => {
      repository.findById.mockResolvedValue(
        createMockCoupon({ min_order_value: 0, max_discount: 0 }) as never,
      );

      const coupon = await service.getCoupon(BUSINESS_ID, COUPON_ID);

      expect(coupon.minOrderValuePaise).toBe(0);
      expect(coupon.maxDiscountPaise).toBe(0);
    });

    it('serialises null validity dates as null', async () => {
      repository.findById.mockResolvedValue(
        createMockCoupon({ valid_from: null, valid_until: null }) as never,
      );

      const coupon = await service.getCoupon(BUSINESS_ID, COUPON_ID);

      expect(coupon.validFrom).toBeNull();
      expect(coupon.validUntil).toBeNull();
    });

    it('serialises present validity dates as ISO strings', async () => {
      const from = new Date('2026-10-01T00:00:00Z');
      const until = new Date('2026-11-01T00:00:00Z');
      repository.findById.mockResolvedValue(
        createMockCoupon({ valid_from: from, valid_until: until }) as never,
      );

      const coupon = await service.getCoupon(BUSINESS_ID, COUPON_ID);

      expect(coupon.validFrom).toBe(from.toISOString());
      expect(coupon.validUntil).toBe(until.toISOString());
    });
  });

  // ─────────────────────────────────────────────
  // listCoupons
  // ─────────────────────────────────────────────

  describe('listCoupons', () => {
    it('maps each row and carries the pagination envelope through', async () => {
      repository.list.mockResolvedValue({
        data: [createMockCoupon(), createMockCoupon({ id: 'c2', code: 'HOLI10' })],
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      } as never);

      const result = await service.listCoupons(BUSINESS_ID, {});

      expect(result).toMatchObject({ total: 2, page: 1, limit: 20, totalPages: 1 });
      expect(result.data.map((c) => c.code)).toEqual(['DIWALI20', 'HOLI10']);
    });

    it('forwards the filters to the repository unchanged', async () => {
      repository.list.mockResolvedValue({
        data: [],
        total: 0,
        page: 2,
        limit: 5,
        totalPages: 0,
      } as never);

      await service.listCoupons(BUSINESS_ID, { isActive: false, page: 2, limit: 5 });

      expect(repository.list).toHaveBeenCalledWith(BUSINESS_ID, {
        isActive: false,
        page: 2,
        limit: 5,
      });
    });

    it('returns an empty page for a tenant with no coupons', async () => {
      repository.list.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      } as never);

      await expect(service.listCoupons(BUSINESS_ID, {})).resolves.toMatchObject({
        data: [],
        total: 0,
      });
    });
  });

  // ─────────────────────────────────────────────
  // updateCoupon
  // ─────────────────────────────────────────────

  describe('updateCoupon', () => {
    it('404s and writes nothing for an unknown coupon', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.updateCoupon(BUSINESS_ID, COUPON_ID, { value: 15 }),
      ).rejects.toThrow(new NotFoundException(`Coupon not found: ${COUPON_ID}`));
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects raising the value past 100 on a stored PERCENT coupon', async () => {
      // The DTO does not restate `type`, so the ceiling has to be checked
      // against the stored type — otherwise this PATCH slips through.
      repository.findById.mockResolvedValue(
        createMockCoupon({ type: DiscountType.PERCENT }) as never,
      );

      await expect(
        service.updateCoupon(BUSINESS_ID, COUPON_ID, { value: 150 }),
      ).rejects.toThrow(new BadRequestException('PERCENT coupon value cannot exceed 100'));
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects switching an over-100 coupon to PERCENT in the same PATCH', async () => {
      repository.findById.mockResolvedValue(
        createMockCoupon({ type: DiscountType.FIXED, value: 500 }) as never,
      );

      await expect(
        service.updateCoupon(BUSINESS_ID, COUPON_ID, {
          type: DiscountType.PERCENT,
          value: 500,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows a value above 100 on a FIXED coupon', async () => {
      // ₹500 off is a perfectly good fixed discount.
      repository.findById.mockResolvedValue(
        createMockCoupon({ type: DiscountType.FIXED }) as never,
      );

      await service.updateCoupon(BUSINESS_ID, COUPON_ID, { value: 500 });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({ value: 500 }),
      );
    });

    it('allows switching a PERCENT coupon to FIXED with a large value', async () => {
      repository.findById.mockResolvedValue(
        createMockCoupon({ type: DiscountType.PERCENT }) as never,
      );

      await service.updateCoupon(BUSINESS_ID, COUPON_ID, {
        type: DiscountType.FIXED,
        value: 500,
      });

      expect(repository.update).toHaveBeenCalled();
    });

    it('allows a PERCENT value of exactly 100', async () => {
      await service.updateCoupon(BUSINESS_ID, COUPON_ID, { value: 100 });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({ value: 100 }),
      );
    });

    it('skips the ceiling check when the PATCH does not touch the value', async () => {
      await service.updateCoupon(BUSINESS_ID, COUPON_ID, { description: 'Festive offer' });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({ description: 'Festive offer' }),
      );
    });

    it('parses supplied validity dates into Date objects', async () => {
      await service.updateCoupon(BUSINESS_ID, COUPON_ID, {
        validFrom: '2026-10-01T00:00:00.000Z',
        validUntil: '2026-11-01T00:00:00.000Z',
      });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({
          validFrom: new Date('2026-10-01T00:00:00.000Z'),
          validUntil: new Date('2026-11-01T00:00:00.000Z'),
        }),
      );
    });

    it('leaves validity dates undefined when the PATCH omits them', async () => {
      // `undefined` means "leave alone" to the repository patch builder.
      await service.updateCoupon(BUSINESS_ID, COUPON_ID, { isActive: false });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({ validFrom: undefined, validUntil: undefined }),
      );
    });

    it('forwards every updatable field', async () => {
      await service.updateCoupon(BUSINESS_ID, COUPON_ID, {
        description: 'Festive offer',
        type: DiscountType.FIXED,
        value: 250,
        minOrderValue: 1000,
        maxDiscount: 500,
        usageLimit: 100,
        perClientLimit: 1,
        isActive: true,
      });

      expect(repository.update).toHaveBeenCalledWith(
        BUSINESS_ID,
        COUPON_ID,
        expect.objectContaining({
          description: 'Festive offer',
          type: DiscountType.FIXED,
          value: 250,
          minOrderValue: 1000,
          maxDiscount: 500,
          usageLimit: 100,
          perClientLimit: 1,
          isActive: true,
        }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // deactivateCoupon
  // ─────────────────────────────────────────────

  describe('deactivateCoupon', () => {
    it('404s and writes nothing for an unknown coupon', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.deactivateCoupon(BUSINESS_ID, COUPON_ID)).rejects.toThrow(
        new NotFoundException(`Coupon not found: ${COUPON_ID}`),
      );
      expect(repository.softDelete).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────
  // createCoupon — remaining optional-field branches
  // ─────────────────────────────────────────────

  describe('createCoupon optional fields', () => {
    beforeEach(() => {
      repository.findByCode.mockResolvedValue(null);
      repository.create.mockResolvedValue(createMockCoupon() as never);
    });

    it('leaves validity dates undefined when neither is supplied', async () => {
      await service.createCoupon(BUSINESS_ID, {
        code: 'diwali20',
        type: DiscountType.PERCENT,
        value: 20,
      } as never);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ validFrom: undefined, validUntil: undefined }),
      );
    });

    it('accepts a validFrom with no validUntil (an open-ended coupon)', async () => {
      // The ordering guard only applies when both bounds are present.
      await service.createCoupon(BUSINESS_ID, {
        code: 'DIWALI20',
        type: DiscountType.PERCENT,
        value: 20,
        validFrom: '2026-10-01T00:00:00.000Z',
      } as never);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          validFrom: new Date('2026-10-01T00:00:00.000Z'),
          validUntil: undefined,
        }),
      );
    });

    it('accepts a validUntil with no validFrom', async () => {
      await service.createCoupon(BUSINESS_ID, {
        code: 'DIWALI20',
        type: DiscountType.PERCENT,
        value: 20,
        validUntil: '2026-11-01T00:00:00.000Z',
      } as never);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          validFrom: undefined,
          validUntil: new Date('2026-11-01T00:00:00.000Z'),
        }),
      );
    });

    it('rejects a validity window that starts and ends at the same instant', async () => {
      await expect(
        service.createCoupon(BUSINESS_ID, {
          code: 'DIWALI20',
          type: DiscountType.PERCENT,
          value: 20,
          validFrom: '2026-10-01T00:00:00.000Z',
          validUntil: '2026-10-01T00:00:00.000Z',
        } as never),
      ).rejects.toThrow(new BadRequestException('validFrom must be before validUntil'));
    });

    it('allows a FIXED coupon with a value above 100', async () => {
      await service.createCoupon(BUSINESS_ID, {
        code: 'FLAT500',
        type: DiscountType.FIXED,
        value: 500,
      } as never);

      expect(repository.create).toHaveBeenCalled();
    });

    it('allows a PERCENT coupon at exactly 100', async () => {
      await service.createCoupon(BUSINESS_ID, {
        code: 'FREE',
        type: DiscountType.PERCENT,
        value: 100,
      } as never);

      expect(repository.create).toHaveBeenCalled();
    });
  });
});
