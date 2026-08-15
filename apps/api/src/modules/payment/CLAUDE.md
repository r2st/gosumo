# Module: payment

Handles all money movement: creates payment links (Razorpay for India, Stripe for international) sent to customers via messaging, receives and verifies gateway webhooks, records transactions, processes refunds, generates invoices, reconciles payment status against the gateway, and handles cash-on-delivery (COD) confirmation. The only module that communicates directly with Razorpay and Stripe.

## Purpose

Create payment links that the AI sends to customers, receive gateway webhooks to confirm payments, emit `payment.success` so orders get confirmed, generate and track invoices, reconcile drifted payment status, and enforce refund policy limits read from tenant settings.

## Gateway selection

`createPaymentLink` picks a gateway by currency unless `dto.gateway` overrides it: **INR → Razorpay**, any other currency → **Stripe**. Razorpay uses the Payment Links API; Stripe uses Checkout Sessions (the hosted `url` is the shareable link). `payment_link_id` stores the Razorpay plink id or the Stripe Checkout Session id; webhooks/reconciliation look payments up by it.

## Public API

```typescript
// PaymentService
createPaymentLink(businessId, dto: CreatePaymentLinkDto): Promise<PaymentLinkDto>
getPaymentLink / cancelPaymentLink / listPaymentLinks
initiateRefund(businessId, dto) / getRefund / listRefunds
confirmCODPayment(businessId, dto: ConfirmCODDto): Promise<TransactionDto>
handleRazorpayWebhook(payload, signature) / handleStripeWebhook(payload, signatureHeader)
reconcilePayment(businessId, paymentId) / reconcilePendingPayments(businessId)
getPaymentSummaryForOrder(businessId, orderId): Promise<PaymentSummaryDto>

// InvoiceService
createInvoice(businessId, dto) / getInvoice / listInvoices
issueInvoice(businessId, id) / markInvoicePaid(businessId, id, paymentId?)
renderInvoiceText(businessId, id): Promise<string>   // plain-text for WhatsApp/SMS
```

## Events

**Emits:**
- `payment.created` / `payment.success` / `payment.failed`
- `payment.refund.initiated` / `payment.refund.completed`
- `invoice.created` / `invoice.issued` / `invoice.paid`

**Listens to:**
- `order.created` — auto-create payment link for the order
- `payment.success` — `InvoiceService` marks the linked invoice PAID

## Tables Owned

- `payments` — payment records with gateway IDs, status, payment link details
- `refunds` — refund records with approval tracking
- `invoices` — invoices with line items, totals, and lifecycle (DRAFT → ISSUED → PAID)

## Dependencies

- `@gosumo/shared` — `PaymentStatus`, `PaymentMethod`, `PaymentGateway`, `InvoiceStatus`, currency utils, payment/invoice events
- `@gosumo/tenant` — `getPolicies()` for `refundWindowDays` and max refund amount
- `@gosumo/order` — validates `orderId`, triggers order payment status update
- Razorpay + Stripe REST APIs (called via `fetch`; no SDK dependency)

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/payment
```

## Key Gotchas

- **Webhook idempotency keys name the event's *subject*, not whatever entity rode along.** Razorpay sends every entity an event touches — a `refund.processed` carries `payload.refund` *and* `payload.payment` — and `external_id` is unique in `webhook_events`, so a key that reaches for the payment first makes two partial refunds on one payment collide and silently discards the second. `deriveWebhookExternalId` picks by the event's namespace (`refund.*` → refund, `payment_link.*` → link, `payment.*` → payment) and falls back to a payload digest, never a constant.

- **Razorpay webhook signature MUST be verified** with HMAC-SHA256 using `RAZORPAY_WEBHOOK_SECRET` before processing any event — `razorpay.service.ts` owns this check
- **Webhook idempotency:** `webhook_events` table has unique constraint on `(source, external_id)` — duplicate Razorpay webhook deliveries are silently ignored
- **Refund policy enforcement:** refund amount cannot exceed the payment's **refundable balance** AND cannot exceed `business_policies.maxRefundAmountPaise` — both checks happen before calling Razorpay
- **Refundable balance, not original amount:** a `PARTIALLY_REFUNDED` payment is refundable again, so the ceiling is `original − sumCommittedRefundsForPayment()`. "Committed" is INITIATED + PROCESSING + COMPLETED — refunds still in flight at the gateway count, because the money is already requested; waiting for COMPLETED would let a duplicate through for as long as the gateway takes to settle. `sumCompletedRefundsForPayment()` is the *other* sum, used only to decide REFUNDED vs PARTIALLY_REFUNDED on the payment
- **Refunds exceeding policy limits** are NOT auto-rejected; they are routed to HITL for manual approval (`requires_approval: true` on the refund record)
- **COD payments** have no gateway ID; they are confirmed by staff via `confirmCODPayment()` and recorded as `method: COD`, `gateway: MANUAL`
- **Payment link default expiry:** 1440 minutes (24h); configurable per business via `PAYMENT_LINK_EXPIRY_MINUTES` constant
- **All monetary amounts** in the `payments` and `refunds` tables are stored as `Decimal(14,2)` (rupees). Convert to paise only for business logic comparisons using `rupeesToPaise()` from `@gosumo/shared`
- Razorpay credentials (`key_id`, `key_secret`, `webhook_secret`) must come from `ConfigService`, never hardcoded
- **Stripe webhook signature** uses the `Stripe-Signature: t=…,v1=…` scheme: the signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256 keyed by `STRIPE_WEBHOOK_SECRET`. Timestamps outside a 5-minute window are rejected (replay protection). Verify before processing — `stripe.service.ts` owns this
- **Both webhook endpoints need the raw body** — they are `@Public()` and use `req.rawBody`; never verify the signature against the parsed/re-serialized body
- **Reconciliation** (`reconcilePayment` / `reconcilePendingPayments`) is the safety net for missed webhooks: it polls the gateway for PENDING/INITIATED payments and updates status + emits the same domain events the webhook would have
- **Invoice numbers** are per-business, per-year sequential (`INV-YYYY-NNNNNN`) with a unique constraint on `(business_id, invoice_number)`; amounts in the `invoices` table are stored in the currency major unit as `Decimal(14,2)`
