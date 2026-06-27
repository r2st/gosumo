# Package: @gosumo/shared

The single source of truth for all cross-module TypeScript contracts. Contains zero business logic — only types, DTOs, enums, domain event payload types, utility functions, and interfaces. Every module in the monorepo depends on this package; it depends on nothing.

## Purpose

Define stable contracts that enable AI agents to work on individual modules independently. When a type changes here, it propagates to all consumers via TypeScript's compile-time checking.

## Package Structure

```
src/
  enums/
    channel.enum.ts           # ChannelType: WHATSAPP | INSTAGRAM | SMS | WEB_CHAT | EMAIL
    conversation.enum.ts      # ConversationStatus, EscalationReason
    message.enum.ts           # MessageDirection, MessageType, MessageStatus
    order.enum.ts             # OrderStatus, FulfillmentType, CatalogItemType
    payment.enum.ts           # PaymentStatus, PaymentMethod, PaymentGateway, RefundStatus
    booking.enum.ts           # BookingStatus
    campaign.enum.ts          # CampaignStatus, CampaignType
    hitl.enum.ts              # TaskStatus, TaskType, TaskPriority, AiDecisionOutcome
    ai.enum.ts                # AiDecisionType, EmbeddingEntityType
    user.enum.ts              # TeamMemberRole: OWNER | MANAGER | STAFF | VIEWER
    index.ts
  interfaces/
    normalized-message.interface.ts   # NormalizedMessage, MessageContent variants
    channel-adapter.interface.ts      # ChannelAdapter contract (implement to add a channel)
    tenant-context.interface.ts       # TenantContext injected into every request
    paginated-result.interface.ts     # PaginatedResult<T>
    ai-result.interface.ts            # AIResult, IntentClassification, ConfidenceScore
    index.ts
  events/
    message.events.ts        # MessageReceivedEvent, MessageSentEvent, MessageFailedEvent
    conversation.events.ts   # ConversationCreatedEvent, etc.
    ai.events.ts             # IntentClassifiedEvent, ResponseGeneratedEvent, etc.
    task.events.ts           # TaskCreatedEvent, TaskResolvedEvent
    order.events.ts          # OrderCreatedEvent, OrderPaidEvent, etc.
    payment.events.ts        # PaymentCreatedEvent, PaymentSuccessEvent, etc.
    booking.events.ts        # BookingCreatedEvent, BookingCancelledEvent, etc.
    client.events.ts         # ClientProfileUpdatedEvent, ChurnRiskEvent
    campaign.events.ts       # CampaignTriggeredEvent, CampaignSentEvent
    index.ts
  dto/
    pagination.dto.ts        # PaginationQueryDto, PaginatedResponseDto
    id-param.dto.ts          # UuidParamDto
    index.ts
  utils/
    date.utils.ts            # toIST(), formatDateIST(), isBusinessHours()
    phone.utils.ts           # normalizeIndianPhone(), maskPhone()
    currency.utils.ts        # formatINR(), paiseToRupees(), rupeesToPaise()
    slug.utils.ts            # toSlug(), generateSKU()
    crypto.utils.ts          # generateOtp(), hashOtp(), maskPII()
    index.ts
  index.ts                   # Re-exports everything
```

## Commands

```bash
pnpm --filter @gosumo/shared test      # Unit tests for utilities
pnpm --filter @gosumo/shared build     # Compile TypeScript
```

## Domain Event Base Shape

All event payloads extend this base:

```typescript
interface DomainEvent {
  eventId: string;       // uuid v4
  occurredAt: Date;
  businessId: string;    // tenant isolation — always present
  version: number;       // schema version for forward compatibility
}
```

## Key Business Rules Encoded Here

- **Monetary amounts are integers (paise).** `rupeesToPaise(rupees: number): number` and `paiseToRupees(paise: number): number` are the only authorized conversion points
- **Phone numbers normalized to E.164:** `+91XXXXXXXXXX` — use `normalizeIndianPhone()` on every inbound phone number
- **Timestamps stored UTC; displayed IST** — `toIST(date: Date)` for UI display
- **`businessId` is UUID** — always validate with `isUUID(businessId, '4')` from `class-validator`

## Key Gotchas

- **This package has zero runtime dependencies** — no NestJS, no Prisma, no axios. Pure TypeScript only
- **Utility functions are pure** — no side effects, no I/O; unit test coverage must be 100%
- **Adding a new domain event:** add the payload type in the relevant `events/` file, re-export from `events/index.ts`, then re-export from `src/index.ts`
- **Adding a new enum value** is a breaking change if any module uses exhaustive switch statements — grep for usages before adding
- **`ChannelAdapter` interface** in `interfaces/channel-adapter.interface.ts` is the contract to implement when adding a new messaging channel
