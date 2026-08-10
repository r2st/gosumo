import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { CouponService } from './coupon.service';
import { CouponRepository } from './coupon.repository';
import { DiscountType } from '@gosumo/shared';

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const COUPON_ID = '00000000-0000-4000-8000-000000000010';

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
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('CouponService', () => {
  let service: CouponService;
  let repository: jest.Mocked<CouponRepository>;

  beforeEach(async () => {
    const mockRepository: jest.Mocked<Partial<CouponRepository>> = {
      create: jest.fn(),
      findByCode: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      incrementUsage: jest.fn(),
      countClientRedemptions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CouponService,
        { provide: CouponRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<CouponService>(CouponService);
    repository = module.get(CouponRepository) as jest.Mocked<CouponRepository>;
  });

  describe('createCoupon', () => {
    it('normalizes code to uppercase and creates', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.create.mockResolvedValue(createMockCoupon() as never);

      await service.createCoupon(BUSINESS_ID, {
        code: 'diwali20',
        type: DiscountType.PERCENT,
        value: 20,
      });

      const call = repository.create.mock.calls[0]?.[0];
      expect(call?.code).toBe('DIWALI20');
    });

    it('rejects PERCENT coupon with value > 100', async () => {
      repository.findByCode.mockResolvedValue(null);
      await expect(
        service.createCoupon(BUSINESS_ID, {
          code: 'BIG',
          type: DiscountType.PERCENT,
          value: 150,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects duplicate code', async () => {
      repository.findByCode.mockResolvedValue(createMockCoupon() as never);
      await expect(
        service.createCoupon(BUSINESS_ID, {
          code: 'DIWALI20',
          type: DiscountType.PERCENT,
          value: 20,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects validFrom after validUntil', async () => {
      repository.findByCode.mockResolvedValue(null);
      await expect(
        service.createCoupon(BUSINESS_ID, {
          code: 'WINDOW',
          type: DiscountType.FIXED,
          value: 50,
          validFrom: '2026-12-01T00:00:00Z',
          validUntil: '2026-01-01T00:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validateAndComputeDiscount', () => {
    it('computes a PERCENT discount', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ type: DiscountType.PERCENT, value: 20 }) as never,
      );

      const result = await service.validateAndComputeDiscount(
        BUSINESS_ID,
        'DIWALI20',
        CLIENT_ID,
        100000, // 1000.00 INR
      );

      expect(result.discountPaise).toBe(20000); // 20%
      expect(result.type).toBe(DiscountType.PERCENT);
    });

    it('caps a PERCENT discount at max_discount', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({
          type: DiscountType.PERCENT,
          value: 50,
          max_discount: 100, // 100 INR cap
        }) as never,
      );

      const result = await service.validateAndComputeDiscount(
        BUSINESS_ID,
        'DIWALI20',
        CLIENT_ID,
        100000,
      );

      expect(result.discountPaise).toBe(10000); // capped at 100 INR
    });

    it('computes a FIXED discount in paise', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ type: DiscountType.FIXED, value: 150 }) as never,
      );

      const result = await service.validateAndComputeDiscount(
        BUSINESS_ID,
        'FLAT150',
        CLIENT_ID,
        100000,
      );

      expect(result.discountPaise).toBe(15000); // 150 INR
    });

    it('never lets the discount exceed the subtotal', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ type: DiscountType.FIXED, value: 5000 }) as never,
      );

      const result = await service.validateAndComputeDiscount(
        BUSINESS_ID,
        'FLAT5000',
        CLIENT_ID,
        100000, // 1000 INR subtotal, coupon worth 5000 INR
      );

      expect(result.discountPaise).toBe(100000);
    });

    it('rejects an unknown coupon', async () => {
      repository.findByCode.mockResolvedValue(null);
      await expect(
        service.validateAndComputeDiscount(BUSINESS_ID, 'NOPE', CLIENT_ID, 100000),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an inactive coupon', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ is_active: false }) as never,
      );
      await expect(
        service.validateAndComputeDiscount(BUSINESS_ID, 'DIWALI20', CLIENT_ID, 100000),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an expired coupon', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ valid_until: new Date('2020-01-01T00:00:00Z') }) as never,
      );
      await expect(
        service.validateAndComputeDiscount(
          BUSINESS_ID,
          'DIWALI20',
          CLIENT_ID,
          100000,
          new Date('2026-06-27T00:00:00Z'),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a not-yet-active coupon', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ valid_from: new Date('2099-01-01T00:00:00Z') }) as never,
      );
      await expect(
        service.validateAndComputeDiscount(
          BUSINESS_ID,
          'DIWALI20',
          CLIENT_ID,
          100000,
          new Date('2026-06-27T00:00:00Z'),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when global usage limit reached', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ usage_limit: 5, usage_count: 5 }) as never,
      );
      await expect(
        service.validateAndComputeDiscount(BUSINESS_ID, 'DIWALI20', CLIENT_ID, 100000),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when per-client limit reached', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ per_client_limit: 1 }) as never,
      );
      repository.countClientRedemptions.mockResolvedValue(1);
      await expect(
        service.validateAndComputeDiscount(BUSINESS_ID, 'DIWALI20', CLIENT_ID, 100000),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when subtotal below min_order_value', async () => {
      repository.findByCode.mockResolvedValue(
        createMockCoupon({ min_order_value: 2000 }) as never,
      );
      await expect(
        service.validateAndComputeDiscount(
          BUSINESS_ID,
          'DIWALI20',
          CLIENT_ID,
          100000, // 1000 INR < 2000 INR min
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('redeem', () => {
    it('increments usage count', async () => {
      repository.incrementUsage.mockResolvedValue();
      await service.redeem(BUSINESS_ID, COUPON_ID);
      expect(repository.incrementUsage).toHaveBeenCalledWith(BUSINESS_ID, COUPON_ID);
    });
  });

  describe('getCoupon', () => {
    it('throws NotFound for unknown coupon', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.getCoupon(BUSINESS_ID, COUPON_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deactivateCoupon', () => {
    it('soft-deletes an existing coupon', async () => {
      repository.findById.mockResolvedValue(createMockCoupon() as never);
      repository.softDelete.mockResolvedValue(
        createMockCoupon({ is_active: false, deleted_at: new Date() }) as never,
      );

      const result = await service.deactivateCoupon(BUSINESS_ID, COUPON_ID);
      expect(result.isActive).toBe(false);
      expect(repository.softDelete).toHaveBeenCalledWith(BUSINESS_ID, COUPON_ID);
    });
  });
});
