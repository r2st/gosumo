import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CouponService } from './coupon.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateCouponDto,
  UpdateCouponDto,
  ListCouponsQueryDto,
  ValidateCouponQueryDto,
} from './dto/coupon.dto';

/**
 * CouponController — REST endpoints for managing discount coupons.
 *
 * Routes:
 *   POST   /coupons                 — create a coupon
 *   GET    /coupons                 — list coupons
 *   GET    /coupons/validate        — preview a discount for a subtotal
 *   GET    /coupons/:id             — get a coupon
 *   PATCH  /coupons/:id             — update a coupon
 *   DELETE /coupons/:id             — deactivate (soft delete) a coupon
 */
@ApiTags('coupons')
@Controller('coupons')
export class CouponController {
  constructor(private readonly couponService: CouponService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a discount coupon' })
  @ApiResponse({ status: 201, description: 'Coupon created' })
  @ApiResponse({ status: 409, description: 'Coupon code already exists' })
  async create(@TenantId() tenantId: string, @Body() dto: CreateCouponDto) {
    return this.couponService.createCoupon(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List coupons' })
  @ApiResponse({ status: 200, description: 'Paginated list of coupons' })
  async list(@TenantId() tenantId: string, @Query() query: ListCouponsQueryDto) {
    return this.couponService.listCoupons(tenantId, {
      isActive: query.isActive,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('validate')
  @ApiOperation({ summary: 'Validate a coupon and preview the discount' })
  @ApiResponse({ status: 200, description: 'Computed discount' })
  @ApiResponse({ status: 400, description: 'Coupon invalid or not applicable' })
  async validate(
    @TenantId() tenantId: string,
    @Query() query: ValidateCouponQueryDto,
  ) {
    return this.couponService.validateAndComputeDiscount(
      tenantId,
      query.code,
      query.clientId,
      query.subtotalPaise,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a coupon by ID' })
  @ApiParam({ name: 'id', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon details' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.couponService.getCoupon(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a coupon' })
  @ApiParam({ name: 'id', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon updated' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    return this.couponService.updateCoupon(tenantId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate (soft-delete) a coupon' })
  @ApiParam({ name: 'id', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon deactivated' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  async remove(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.couponService.deactivateCoupon(tenantId, id);
  }
}
