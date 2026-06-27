import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { CouponController } from './coupon.controller';
import { CouponService } from './coupon.service';
import { CouponRepository } from './coupon.repository';
import { AddressController } from './address.controller';
import { AddressService } from './address.service';
import { AddressRepository } from './address.repository';

/**
 * OrderModule wires together the commerce-fulfilment surface:
 *  - Orders   — lifecycle, line-item snapshots, shipment dispatch
 *  - Cart     — pre-checkout staging that converts into orders
 *  - Coupons  — discount definitions + validation/redemption
 *  - Address  — customer shipping addresses with validation
 *
 * OrderService is exported for synchronous reads by other modules (e.g. the AI
 * engine querying order status). CouponService is exported so other commerce
 * flows can validate discounts.
 */
@Module({
  controllers: [
    OrderController,
    CartController,
    CouponController,
    AddressController,
  ],
  providers: [
    PrismaService,
    OrderService,
    OrderRepository,
    CartService,
    CartRepository,
    CouponService,
    CouponRepository,
    AddressService,
    AddressRepository,
  ],
  exports: [OrderService, CouponService, AddressService],
})
export class OrderModule {}
