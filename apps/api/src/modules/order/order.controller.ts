import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { OrderService } from './order.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateOrderDto,
  UpdateOrderStatusDto,
  CancelOrderDto,
  CreateShipmentDto,
  MarkPackedDto,
  ReturnOrderDto,
  ListOrdersQueryDto,
} from './dto';

/**
 * OrderController — REST endpoints for order management.
 *
 * All routes are protected by the global JwtAuthGuard. The @TenantId()
 * decorator extracts the businessId from the JWT-populated request context.
 *
 * Routes:
 *   POST   /orders                          — create a new order
 *   GET    /orders                          — list orders with filters
 *   GET    /orders/client/:clientId         — orders for a specific client
 *   GET    /orders/:id                      — get a single order
 *   PATCH  /orders/:id/cancel               — cancel an order
 *   PATCH  /orders/:id/status               — update order status
 *   PATCH  /orders/:id/pack                 — mark order as packed
 *   POST   /orders/:id/shipment             — create a shipment
 *   GET    /orders/client/:clientId/status   — AI-friendly order status
 */
@ApiTags('orders')
@Controller('orders')
export class OrderController {
  private readonly logger = new Logger(OrderController.name);

  constructor(private readonly orderService: OrderService) {}

  // ───────────────────────────────────────────────────────────────────
  // Order CRUD
  // ───────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new order' })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({ status: 400, description: 'Validation error or insufficient stock' })
  async createOrder(
    @TenantId() tenantId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orderService.createOrder(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List orders with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of orders' })
  async listOrders(
    @TenantId() tenantId: string,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orderService.listOrders(tenantId, query);
  }

  @Get('client/:clientId')
  @ApiOperation({ summary: 'Get orders for a specific client' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'List of orders for client' })
  async getOrdersForClient(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.orderService.getRecentOrdersForClient(tenantId, clientId);
  }

  @Get('client/:clientId/status')
  @ApiOperation({ summary: 'Get AI-friendly order status summary for a client' })
  @ApiParam({ name: 'clientId', description: 'Client UUID' })
  @ApiResponse({ status: 200, description: 'Order status summary' })
  async getOrderStatusForClient(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
    @Query('orderId') orderId?: string,
  ) {
    return this.orderService.getOrderStatusForClient(tenantId, clientId, orderId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.orderService.getOrder(tenantId, id);
  }

  // ───────────────────────────────────────────────────────────────────
  // Order Actions
  // ───────────────────────────────────────────────────────────────────

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel an order' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 400, description: 'Cannot cancel order in current status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async cancelOrder(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orderService.cancelOrder(tenantId, id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateOrderStatus(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orderService.updateOrderStatus(tenantId, id, dto);
  }

  @Patch(':id/pack')
  @ApiOperation({ summary: 'Mark order as packed' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order marked as packed' })
  @ApiResponse({ status: 400, description: 'Order not in PROCESSING status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async markPacked(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: MarkPackedDto,
  ) {
    return this.orderService.markPacked(tenantId, id, dto);
  }

  @Post(':id/shipment')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a shipment for a packed order' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 201, description: 'Shipment created, order shipped' })
  @ApiResponse({ status: 400, description: 'Order not in PACKED status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async createShipment(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: CreateShipmentDto,
  ) {
    return this.orderService.createShipment(tenantId, id, dto);
  }

  @Patch(':id/return')
  @ApiOperation({ summary: 'Mark a delivered/shipped order as returned' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order returned' })
  @ApiResponse({ status: 400, description: 'Order cannot be returned in current status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async returnOrder(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ReturnOrderDto,
  ) {
    return this.orderService.returnOrder(tenantId, id, dto);
  }
}
