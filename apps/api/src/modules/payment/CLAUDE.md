# Module: payment

Handles all money movement: creates Razorpay payment links sent to customers via messaging, receives and verifies payment webhooks, records transactions, processes refunds, and handles cash-on-delivery (COD) confirmation. The only module that communicates directly with Razorpay.

## Purpose

Create payment links that the AI sends to customers, receive Razorpay webhooks to confirm payments, emit `payment.success` so orders get confirmed, and enforce refund policy limits read from tenant settings.

## Public API (IPaymentService)

```typescript
createPaymentLink(businessId, dto: CreatePaymentLinkDto): Promise<PaymentLinkDto>
getPaymentLink / cancelPaymentLink / listPaymentLinks
getTransaction / listTransactions
initiateRefund(businessId, dto: InitiateRefundDto): Promise<RefundDto>
getRefund(businessId, refundId): Promise<RefundDto>
confirmCODPayment(businessId, orderId, dto): Promise<TransactionDto>
handleRazorpayWebhook(payload: Buffer, signature: string): Promise<void>
getPaymentSummaryForOrder(businessId, orderId): Promise<PaymentSummaryDto>
```

## Events

**Emits:**
- `payment.created` — `{ businessId, paymentLinkId, orderId?, amountPaise }`
- `payment.success` — `{ businessId, transactionId, paymentLinkId, orderId?, amountPaise, method }`
- `payment.failed` — `{ businessId, paymentLinkId, orderId?, reason }`
- `payment.refund.initiated` — `{ businessId, refundId, transactionId, amountPaise }`
- `payment.refund.completed` — `{ businessId, refundId, transactionId, amountPaise }`

**Listens to:**
- `order.created` — auto-create payment link if payment method is ONLINE

## Tables Owned

- `payments` — payment records with gateway IDs, status, payment link details
- `refunds` — refund records with approval tracking

## Dependencies

- `@gosumo/shared` — `PaymentStatus`, `PaymentMethod`, currency utils
- `@gosumo/tenant` — `getPolicies()` for `refundWindowDays` and max refund amount
- `@gosumo/order` — validates `orderId`, triggers order payment status update
- Razorpay Node.js SDK

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/payment
```

## Key Gotchas

- **Razorpay webhook signature MUST be verified** with HMAC-SHA256 using `RAZORPAY_WEBHOOK_SECRET` before processing any event — `razorpay.service.ts` owns this check
- **Webhook idempotency:** `webhook_events` table has unique constraint on `(source, external_id)` — duplicate Razorpay webhook deliveries are silently ignored
- **Refund policy enforcement:** refund amount cannot exceed original transaction amount AND cannot exceed `business_policies.maxRefundAmountPaise` — both checks happen before calling Razorpay
- **Refunds exceeding policy limits** are NOT auto-rejected; they are routed to HITL for manual approval (`requires_approval: true` on the refund record)
- **COD payments** have no gateway ID; they are confirmed by staff via `confirmCODPayment()` and recorded as `method: COD`, `gateway: MANUAL`
- **Payment link default expiry:** 1440 minutes (24h); configurable per business via `PAYMENT_LINK_EXPIRY_MINUTES` constant
- **All monetary amounts** in the `payments` and `refunds` tables are stored as `Decimal(14,2)` (rupees). Convert to paise only for business logic comparisons using `rupeesToPaise()` from `@gosumo/shared`
- Razorpay credentials (`key_id`, `key_secret`, `webhook_secret`) must come from `ConfigService`, never hardcoded
