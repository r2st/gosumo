# Module: shipping

Abstracts all logistics operations behind a single interface. Integrates with Shiprocket (India's primary logistics aggregator) to create shipments, fetch tracking updates, initiate returns, and manage delivery addresses. Auto-selects the cheapest/fastest provider based on destination.

## Purpose

Handle everything after an order is packed: create the Shiprocket shipment, poll for tracking updates, push status changes to `order` and customers, and handle returns. The only module that talks to Shiprocket.

## Public API (IShippingService)

```typescript
createShipment(businessId, dto: CreateShipmentDto): Promise<ShipmentDto>
getShipment / cancelShipment / listShipments
getTrackingInfo(businessId, shipmentId): Promise<TrackingInfoDto>
refreshTracking(businessId, shipmentId): Promise<TrackingInfoDto>
createReturn / getReturn
validateAddress(address): Promise<AddressValidationDto>
getServiceability(fromPincode, toPincode): Promise<ServiceabilityDto>
estimateShippingCost(businessId, dto): Promise<ShippingEstimateDto[]>
updatePickupAddress / getPickupAddress
handleShiprocketWebhook(payload): Promise<void>
```

## Events

**Emits:**
- `shipping.created` — `{ businessId, shipmentId, orderId, trackingId, provider }`
- `shipping.shipped` — `{ businessId, shipmentId, orderId, dispatchedAt }`
- `shipping.out_for_delivery` — `{ businessId, shipmentId, orderId }`
- `shipping.delivered` — `{ businessId, shipmentId, orderId, deliveredAt }`
- `shipping.failed` — `{ businessId, shipmentId, orderId, reason }`
- `shipping.return.created` — `{ businessId, returnId, shipmentId }`

**Listens to:**
- `order.packed` → `createShipment()` if auto-ship is configured for the business

## Tables Owned

- `shipments` — shipment records with Shiprocket IDs, AWB code, tracking URL, status timeline
- (Returns are stored in shipment `metadata` or as additional shipment records; implement as needed)

## Dependencies

- `@gosumo/shared` — address types, currency utils
- `@gosumo/order` — validates `orderId`, receives `order.packed` event
- `@gosumo/tenant` — business pickup address configuration
- Shiprocket REST API

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/shipping
```

## Key Gotchas

- **Shiprocket authentication uses email/password** (not API key) — exchanges credentials for a JWT token, cached in Redis with TTL. If token is expired, refresh silently before every API call
- **If Shiprocket is unavailable**, queue the shipment creation for retry via BullMQ — the order stays in PACKED status until successfully shipped
- **Tracking updates:** use webhooks when Shiprocket sends them; fall back to polling via a BullMQ repeatable job every 60 minutes for in-transit shipments
- **COD amount must be set** on the Shiprocket shipment if the order payment method is COD — Shiprocket uses this for cash collection
- **Returns can only be created** for orders in DELIVERED status
- **Tracking events** are stored in `shipments.tracking_events` as a JSONB array — append-only. Never delete tracking history
- **Customer notifications** are sent only on `SHIPPED` and `DELIVERED` status — not on every intermediate event
- `estimateShippingCost()` returns multiple provider options sorted by cost ascending; the cheapest is pre-selected but the operator can override
- Shiprocket credentials (`email`, `password`) must be encrypted at rest in `channel_accounts` / business config — never log them
