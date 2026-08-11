import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CartService } from './cart.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  AddCartItemDto,
  UpdateCartItemDto,
  ApplyCartCouponDto,
  CheckoutCartDto,
} from './dto/cart.dto';

/**
 * CartController — REST endpoints for shopping-cart management.
 *
 * A cart belongs to a client; the active cart is resolved (or created) per
 * request. The tenant scope comes from the JWT via @TenantId().
 *
 * Routes (all under /carts/:clientId):
 *   GET    /carts/:clientId                       — get/create active cart
 *   POST   /carts/:clientId/items                 — add an item
 *   PATCH  /carts/:clientId/items/:itemId         — update line quantity
 *   DELETE /carts/:clientId/items/:itemId         — remove a line
 *   DELETE /carts/:clientId/items                 — clear the cart
 *   POST   /carts/:clientId/coupon                — apply a coupon
 *   DELETE /carts/:clientId/coupon                — remove the coupon
 *   POST   /carts/:clientId/checkout              — convert cart to an order
 */
@ApiTags('carts')
@Controller('carts')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get(':clientId')
  @ApiOperation({ summary: 'Get (or create) the active cart for a client' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Active cart' })
  async getCart(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.cartService.getOrCreateCart(tenantId, clientId);
  }

  @Post(':clientId/items')
  @ApiOperation({ summary: 'Add an item to the cart' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 201, description: 'Item added' })
  @ApiResponse({ status: 400, description: 'Catalog item not found or inactive' })
  @HttpCode(HttpStatus.CREATED)
  async addItem(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Body() dto: AddCartItemDto,
  ) {
    return this.cartService.addItem(tenantId, clientId, dto);
  }

  @Patch(':clientId/items/:itemId')
  @ApiOperation({ summary: 'Update a cart line quantity' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiParam({ name: 'itemId', description: 'Cart item (line) UUID' })
  @ApiResponse({ status: 200, description: 'Line updated' })
  @ApiResponse({ status: 404, description: 'Cart item not found' })
  async updateItem(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(tenantId, clientId, itemId, dto);
  }

  @Delete(':clientId/items/:itemId')
  @ApiOperation({ summary: 'Remove a line from the cart' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiParam({ name: 'itemId', description: 'Cart item (line) UUID' })
  @ApiResponse({ status: 200, description: 'Line removed' })
  @ApiResponse({ status: 404, description: 'Cart item not found' })
  async removeItem(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Param('itemId', UuidValidationPipe) itemId: string,
  ) {
    return this.cartService.removeItem(tenantId, clientId, itemId);
  }

  @Delete(':clientId/items')
  @ApiOperation({ summary: 'Clear the cart (remove all items and coupon)' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Cart cleared' })
  async clearCart(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.cartService.clearCart(tenantId, clientId);
  }

  @Post(':clientId/coupon')
  @ApiOperation({ summary: 'Apply a coupon to the cart' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 201, description: 'Coupon applied' })
  @ApiResponse({ status: 400, description: 'Coupon invalid or not applicable' })
  @HttpCode(HttpStatus.CREATED)
  async applyCoupon(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Body() dto: ApplyCartCouponDto,
  ) {
    return this.cartService.applyCoupon(tenantId, clientId, dto);
  }

  @Delete(':clientId/coupon')
  @ApiOperation({ summary: 'Remove the coupon from the cart' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Coupon removed' })
  async removeCoupon(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.cartService.removeCoupon(tenantId, clientId);
  }

  @Post(':clientId/checkout')
  @ApiOperation({ summary: 'Check out the cart and create an order' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 201, description: 'Order created from cart' })
  @ApiResponse({ status: 400, description: 'Empty cart or validation error' })
  @HttpCode(HttpStatus.CREATED)
  async checkout(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Body() dto: CheckoutCartDto,
  ) {
    return this.cartService.checkout(tenantId, clientId, dto);
  }
}
