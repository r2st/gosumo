# Module: order

Manages the complete lifecycle of customer orders from creation through fulfillment. Coordinates between `payment`, `shipping`, and `catalog`. Handles physical goods only — service bookings flow through the `booking` module.

## Purpose

Own the order state machine, generate human-readable order numbers, snapshot prices at order time, coordinate payment collection and shipment dispatch, and provide order status summaries to the AI.

## Public API (IOrderService)

```typescript
createOrder(businessId, dto: CreateOrderDto): Promise<OrderDto>
getOrder / listOrders
cancelOrder(businessId, orderId, dto): Promise<OrderDto>
updateOrderStatus(businessId, orderId, dto): Promise<OrderDto>
markPacked(businessId, orderId, dto): Promise<OrderDto>
createShipment(businessId, orderId, dto): Promise<OrderDto>
getOrderStatusForClient(businessId, clientId, orderId?): Promise<OrderStatusSummaryDto>
getRecentOrdersForClient(businessId, clientId, limit?): Promise<OrderDto[]>
```

## Order Status Flow

```
DRAFT → CONFIRMED → PROCESSING → PACKED → SHIPPED → DELIVERED
                 ↘ CANCELLED → REFUNDED
```

## Events

**Emits:**
- `order.created` — `{ businessId, orderId, clientId, items[], totalAmountPaise, paymentMethod }`
- `order.confirmed` — `{ businessId, orderId, confirmedAt }`
- `order.cancelled` — `{ businessId, orderId, reason, cancelledBy }`
- `order.packed` — `{ businessId, orderId, packageCount }`
- `order.shipped` — `{ businessId, orderId, trackingId, provider }`
- `order.delivered` — `{ businessId, orderId, deliveredAt }`

**Listens to:**
- `payment.success` → transition DRAFT/CONFIRMED → CONFIRMED (with payment confirmed)
- `payment.refund.completed` → transition CANCELLED → REFUNDED
- `shipping.delivered` → transition SHIPPED → DELIVERED

## Tables Owned

- `orders` — order state, line items snapshot (JSONB), financial totals, discount tracking
- `shipping_addresses` — customer delivery addresses (also used by `shipping` module)
- `shipping_options` — available shipping methods configured by business (also used by `shipping` module)

## Dependencies

- `@gosumo/shared` — `OrderStatus`, currency utils
- `@gosumo/catalog` — `getItem()`, `getEffectivePrice()`, `updateStock()` at order creation
- `@gosumo/payment` — `createPaymentLink()` for ONLINE orders; `getPaymentSummaryForOrder()`
- `@gosumo/shipping` — `createShipment()` when order is packed

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/order
```

## Key Gotchas

- **Prices snapshot at order creation time** — line items store `unitPrice` and `totalPrice` from the catalog at that moment; catalog price changes do not affect existing orders
- **Stock reserved at order creation** — `catalog.updateStock()` is called synchronously during `createOrder()`; restored on cancellation via `order.cancelled` listener in catalog
- **Auto-cancel:** DRAFT orders not paid within 24h are auto-cancelled via a BullMQ delayed job (`AUTO_CANCEL_PENDING_PAYMENT_HOURS = 24`)
- **COD orders** skip payment link creation and go directly to CONFIRMED status; `paymentMethod: COD` in the `CreateOrderDto`
- **Tax is calculated on the effective price** (after discounts), not on the base price
- **Order number format:** `ORD-YYYY-NNNNN` (e.g., `ORD-2024-00042`), unique per business — generated in `order.service.ts` using an atomic counter or padded sequence
- **Cannot cancel** an order that is already SHIPPED — check status before transition
- **`line_items` JSONB snapshot** includes: `itemId`, `variantId`, `name`, `sku`, `quantity`, `unitPrice`, `totalPrice`, `taxAmount` — never a foreign key, to preserve history
