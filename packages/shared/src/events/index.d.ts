import { ChannelType, ConversationStatus, IntentType, OrderStatus, PaymentStatus, BookingStatus } from '../enums';
import { ConfidenceScore, SuggestedAction } from '../interfaces';
/**
 * All domain events extend BaseEvent.
 * The event bus and BullMQ processors use these fields for
 * routing, deduplication, and distributed tracing.
 */
export interface BaseEvent {
    /** Unique event ID (UUID v4) — used for idempotency */
    id: string;
    /** ISO-8601 timestamp of when the event was emitted */
    timestamp: string;
    /** Tenant scope — every event carries businessId for multi-tenant safety */
    businessId: string;
    /** Distributed trace ID shared across all events in one request chain */
    correlationId: string;
}
/** Emitted by the channel adapter after normalizing an inbound message */
export interface MessageReceivedEvent extends BaseEvent {
    readonly type: 'message.received';
    messageId: string;
    conversationId: string;
    channelAccountId: string;
    channel: ChannelType;
    senderExternalId: string;
    clientId: string;
}
/** Emitted after a message is successfully sent to the channel */
export interface MessageSentEvent extends BaseEvent {
    readonly type: 'message.sent';
    messageId: string;
    conversationId: string;
    channelAccountId: string;
    channel: ChannelType;
    externalMessageId: string;
    recipientExternalId: string;
    /** Wall-clock time from emit to channel acknowledgement (ms) */
    latencyMs: number;
}
/** Emitted when an outbound message delivery fails permanently */
export interface MessageFailedEvent extends BaseEvent {
    readonly type: 'message.failed';
    messageId: string;
    conversationId: string;
    channelAccountId: string;
    channel: ChannelType;
    recipientExternalId: string;
    reason: string;
    attempts: number;
}
export interface ConversationCreatedEvent extends BaseEvent {
    readonly type: 'conversation.created';
    conversationId: string;
    clientId: string;
    channelAccountId: string;
    channel: ChannelType;
}
export interface ConversationResolvedEvent extends BaseEvent {
    readonly type: 'conversation.resolved';
    conversationId: string;
    clientId: string;
    /** "AI" | "HUMAN" | "SYSTEM" */
    resolvedBy: string;
    resolvedByActorId?: string;
    /** Duration from first message to resolution (seconds) */
    resolutionDurationSeconds: number;
    csatScore?: number;
}
export interface ConversationEscalatedEvent extends BaseEvent {
    readonly type: 'conversation.escalated';
    conversationId: string;
    clientId: string;
    taskId: string;
    /** The team member the conversation was assigned to */
    assignedToMemberId?: string;
    reason: string;
}
export interface ConversationStatusChangedEvent extends BaseEvent {
    readonly type: 'conversation.status.changed';
    conversationId: string;
    clientId: string;
    previousStatus: ConversationStatus;
    newStatus: ConversationStatus;
    /** ID of the actor who triggered the status change (team_member or system) */
    actorId?: string;
}
export interface ConversationAssignedEvent extends BaseEvent {
    readonly type: 'conversation.assigned';
    conversationId: string;
    clientId: string;
    assigneeId: string;
    /** Previous assignee, if any */
    previousAssigneeId?: string;
}
/**
 * Emitted after a team member is removed (soft-deleted and suspended).
 *
 * Consumed by any module holding work assigned to that member. Removal is the
 * point at which an assignee stops being able to act: the row is soft-deleted
 * and its status set to SUSPENDED, so nothing they hold will ever be opened by
 * them again. Anything still pointing at them has to be released, or it sits in
 * a state nobody is looking at — assigned, so it is out of the unassigned
 * queue, and unresolved, so it never closes.
 *
 * An event rather than a direct call because `ConversationService` already
 * injects `TenantService` for assignee validation; calling back the other way
 * would close the cycle.
 */
export interface TeamMemberRemovedEvent extends BaseEvent {
    readonly type: 'team.member.removed';
    memberId: string;
    /** The member who performed the removal, when the caller supplied one. */
    actorId?: string;
}
/** Emitted after an inbound or outbound message is persisted to the database */
export interface MessageStoredEvent extends BaseEvent {
    readonly type: 'message.stored';
    messageId: string;
    conversationId: string;
    channelAccountId: string;
    channel: ChannelType;
    direction: string;
    senderType: string;
}
export interface AIIntentClassifiedEvent extends BaseEvent {
    readonly type: 'ai.intent.classified';
    conversationId: string;
    messageId: string;
    intent: IntentType;
    confidence: number;
    alternativeIntents: Array<{
        intent: IntentType;
        confidence: number;
    }>;
}
export interface AIResponseGeneratedEvent extends BaseEvent {
    readonly type: 'ai.response.generated';
    conversationId: string;
    messageId: string;
    aiDecisionId: string;
    intent: IntentType;
    confidenceScore: ConfidenceScore;
    suggestedActions: SuggestedAction[];
    modelId: string;
    latencyMs: number;
}
export interface AIResponseApprovedEvent extends BaseEvent {
    readonly type: 'ai.response.approved';
    conversationId: string;
    aiDecisionId: string;
    taskId: string;
    approvedByMemberId: string;
    /** Whether the human edited the AI draft before approving */
    wasEdited: boolean;
}
export interface AIResponseRejectedEvent extends BaseEvent {
    readonly type: 'ai.response.rejected';
    conversationId: string;
    aiDecisionId: string;
    taskId: string;
    rejectedByMemberId: string;
    rejectionReason?: string;
}
export interface TaskCreatedEvent extends BaseEvent {
    readonly type: 'task.created';
    taskId: string;
    conversationId: string;
    aiDecisionId?: string;
    taskType: string;
    priority: string;
    assignedToMemberId?: string;
    dueAt?: string;
}
export interface TaskAssignedEvent extends BaseEvent {
    readonly type: 'task.assigned';
    taskId: string;
    conversationId: string;
    assignedToMemberId: string;
}
export interface TaskResolvedEvent extends BaseEvent {
    readonly type: 'task.resolved';
    taskId: string;
    conversationId: string;
    resolvedByMemberId: string;
    resolutionNote?: string;
    /** Wall-clock time from task creation to resolution (seconds) */
    resolutionDurationSeconds: number;
    slaBreach: boolean;
}
export interface OrderCreatedEvent extends BaseEvent {
    readonly type: 'order.created';
    orderId: string;
    orderNumber: string;
    clientId: string;
    conversationId?: string;
    /** Total in paise */
    totalPaise: number;
    currency: string;
    lineItemCount: number;
}
export interface OrderPaidEvent extends BaseEvent {
    readonly type: 'order.paid';
    orderId: string;
    orderNumber: string;
    clientId: string;
    paymentId: string;
    /** Amount paid in paise */
    amountPaise: number;
    currency: string;
    status: OrderStatus;
}
export interface OrderConfirmedEvent extends BaseEvent {
    readonly type: 'order.confirmed';
    orderId: string;
    orderNumber: string;
    clientId: string;
    confirmedAt: string;
}
export interface OrderCancelledEvent extends BaseEvent {
    readonly type: 'order.cancelled';
    orderId: string;
    orderNumber: string;
    clientId: string;
    reason?: string;
    cancelledBy: string;
}
export interface OrderPackedEvent extends BaseEvent {
    readonly type: 'order.packed';
    orderId: string;
    orderNumber: string;
    clientId: string;
}
export interface OrderShippedEvent extends BaseEvent {
    readonly type: 'order.shipped';
    orderId: string;
    orderNumber: string;
    clientId: string;
    shipmentId: string;
    trackingNumber?: string;
    trackingUrl?: string;
    carrier?: string;
    estimatedDeliveryAt?: string;
}
export interface OrderDeliveredEvent extends BaseEvent {
    readonly type: 'order.delivered';
    orderId: string;
    orderNumber: string;
    clientId: string;
    deliveredAt: string;
}
export interface OrderReturnedEvent extends BaseEvent {
    readonly type: 'order.returned';
    orderId: string;
    orderNumber: string;
    clientId: string;
    reason?: string;
    returnedAt: string;
}
export interface PaymentCreatedEvent extends BaseEvent {
    readonly type: 'payment.created';
    paymentId: string;
    orderId?: string;
    clientId: string;
    /** Amount in paise */
    amountPaise: number;
    currency: string;
    paymentLinkUrl?: string;
}
export interface PaymentSuccessEvent extends BaseEvent {
    readonly type: 'payment.success';
    paymentId: string;
    orderId?: string;
    clientId: string;
    /** Amount captured in paise */
    amountPaise: number;
    currency: string;
    status: PaymentStatus;
    gatewayPaymentId: string;
}
export interface PaymentFailedEvent extends BaseEvent {
    readonly type: 'payment.failed';
    paymentId: string;
    orderId?: string;
    clientId: string;
    /** Amount in paise */
    amountPaise: number;
    currency: string;
    reason: string;
}
export interface PaymentRefundEvent extends BaseEvent {
    readonly type: 'payment.refund.initiated' | 'payment.refund.completed';
    refundId: string;
    paymentId: string;
    orderId?: string;
    clientId: string;
    /** Refund amount in paise */
    amountPaise: number;
    currency: string;
    reason?: string;
}
export interface InvoiceCreatedEvent extends BaseEvent {
    readonly type: 'invoice.created';
    invoiceId: string;
    invoiceNumber: string;
    orderId?: string;
    clientId: string;
    paymentId?: string;
    /** Total amount in paise */
    totalPaise: number;
    currency: string;
}
export interface InvoiceIssuedEvent extends BaseEvent {
    readonly type: 'invoice.issued';
    invoiceId: string;
    invoiceNumber: string;
    clientId: string;
    /** Total amount in paise */
    totalPaise: number;
    currency: string;
}
export interface InvoicePaidEvent extends BaseEvent {
    readonly type: 'invoice.paid';
    invoiceId: string;
    invoiceNumber: string;
    paymentId: string;
    clientId: string;
    /** Total amount in paise */
    totalPaise: number;
    currency: string;
}
export interface BookingCreatedEvent extends BaseEvent {
    readonly type: 'booking.created';
    bookingId: string;
    clientId: string;
    catalogItemId?: string;
    staffMemberId?: string;
    startAt: string;
    endAt: string;
    status: BookingStatus;
}
export interface BookingCancelledEvent extends BaseEvent {
    readonly type: 'booking.cancelled';
    bookingId: string;
    clientId: string;
    /** "CLIENT" | "BUSINESS" | "SYSTEM" */
    cancelledBy: string;
    cancelledByActorId?: string;
    reason?: string;
}
/** Emitted when a booking transitions PENDING → CONFIRMED. */
export interface BookingConfirmedEvent extends BaseEvent {
    readonly type: 'booking.confirmed';
    bookingId: string;
    clientId: string;
    catalogItemId?: string;
    staffMemberId?: string;
    startAt: string;
    endAt: string;
}
/** Emitted when a booking's time is changed. */
export interface BookingRescheduledEvent extends BaseEvent {
    readonly type: 'booking.rescheduled';
    bookingId: string;
    clientId: string;
    staffMemberId?: string;
    oldStartAt: string;
    oldEndAt: string;
    newStartAt: string;
    newEndAt: string;
    /** "CLIENT" | "BUSINESS" | "SYSTEM" */
    rescheduledBy: string;
}
/** Emitted when a booking is marked COMPLETED. */
export interface BookingCompletedEvent extends BaseEvent {
    readonly type: 'booking.completed';
    bookingId: string;
    clientId: string;
    catalogItemId?: string;
    staffMemberId?: string;
}
/**
 * Emitted ahead of an appointment so the notification module can deliver a
 * reminder to the customer. `minutesBefore` distinguishes the 24h vs 1h reminder.
 */
export interface BookingReminderEvent extends BaseEvent {
    readonly type: 'booking.reminder';
    bookingId: string;
    clientId: string;
    catalogItemId?: string;
    staffMemberId?: string;
    startAt: string;
    /** Lead time of this reminder, e.g. 1440 (24h) or 60 (1h). */
    minutesBefore: number;
}
export interface ClientProfileUpdatedEvent extends BaseEvent {
    readonly type: 'client.profile.updated';
    clientId: string;
    /** Only the fields that changed */
    changedFields: string[];
    updatedBy: 'AI' | 'HUMAN' | 'SYSTEM';
    updatedByActorId?: string;
}
/** Emitted by the contact module whenever a contact's tag set changes. */
export interface ContactTaggedEvent extends BaseEvent {
    readonly type: 'contact.tagged';
    contactId: string;
    /** The contact's full tag list after the change. */
    tags: string[];
}
/** Emitted by the canned-response module when a saved reply is used. */
export interface CannedResponseUsedEvent extends BaseEvent {
    readonly type: 'canned_response.used';
    cannedResponseId: string;
    conversationId?: string;
    usedBy?: string;
}
/** Emitted by the sla module when a conversation misses its SLA target. */
export interface SlaBreachedEvent extends BaseEvent {
    readonly type: 'sla.breached';
    conversationId: string;
    policyId: string;
    breachType: 'FIRST_RESPONSE' | 'RESOLUTION';
    targetMinutes: number;
    actualMinutes: number;
}
/** Emitted by the sla module when a breach is escalated per policy action. */
export interface SlaEscalatedEvent extends BaseEvent {
    readonly type: 'sla.escalated';
    conversationId: string;
    policyId: string;
    breachType: 'FIRST_RESPONSE' | 'RESOLUTION';
    action: 'NOTIFY' | 'REASSIGN' | 'CREATE_TASK';
    target?: string;
}
export interface CatalogItemCreatedEvent extends BaseEvent {
    readonly type: 'catalog.item.created';
    itemId: string;
    sku: string;
    categoryId?: string;
}
export interface CatalogItemUpdatedEvent extends BaseEvent {
    readonly type: 'catalog.item.updated';
    itemId: string;
    changedFields: string[];
}
export interface CatalogStockLowEvent extends BaseEvent {
    readonly type: 'catalog.stock.low';
    itemId: string;
    variantId?: string;
    currentStock: number;
    threshold: number;
}
export interface CatalogStockOutEvent extends BaseEvent {
    readonly type: 'catalog.stock.out';
    itemId: string;
    variantId?: string;
}
/** Emitted when a notification has been created and accepted into the queue. */
export interface NotificationQueuedEvent extends BaseEvent {
    readonly type: 'notification.queued';
    notificationId: string;
    clientId?: string;
    /** WHATSAPP | SMS | EMAIL | PUSH */
    channel: string;
    /** TRANSACTIONAL | MARKETING | REMINDER | SYSTEM */
    category: string;
    /** The domain event that triggered it, if any */
    triggerEvent?: string;
    scheduledAt?: string;
}
/** Emitted when a notification was handed to the channel provider. */
export interface NotificationSentEvent extends BaseEvent {
    readonly type: 'notification.sent';
    notificationId: string;
    clientId?: string;
    channel: string;
    category: string;
    recipient: string;
    providerMessageId?: string;
    /** Wall-clock time from dispatch start to provider acknowledgement (ms) */
    latencyMs: number;
}
/** Emitted when the provider confirms delivery to the recipient's device. */
export interface NotificationDeliveredEvent extends BaseEvent {
    readonly type: 'notification.delivered';
    notificationId: string;
    clientId?: string;
    channel: string;
    providerMessageId?: string;
}
/** Emitted when a notification permanently fails after exhausting retries. */
export interface NotificationFailedEvent extends BaseEvent {
    readonly type: 'notification.failed';
    notificationId: string;
    clientId?: string;
    channel: string;
    category: string;
    recipient: string;
    reason: string;
    attempts: number;
}
/** Emitted when a notification is skipped because of an opt-out/preference. */
export interface NotificationSkippedEvent extends BaseEvent {
    readonly type: 'notification.skipped';
    notificationId: string;
    clientId?: string;
    channel: string;
    category: string;
    reason: string;
}
/** Emitted when a new real-estate lead is captured from any source. */
export interface RealtyLeadCreatedEvent extends BaseEvent {
    readonly type: 'realty.lead.created';
    leadId: string;
    source: string;
    whatsappPhone: string;
    listingRef?: string;
    conversationId?: string;
}
/** Emitted when a lead reaches 4/4 BLTC slots + reachable contact. */
export interface RealtyLeadQualifiedEvent extends BaseEvent {
    readonly type: 'realty.lead.qualified';
    leadId: string;
    qualScore: number;
    temperature: string;
}
/** Emitted on any pipeline stage transition. */
export interface RealtyLeadStageChangedEvent extends BaseEvent {
    readonly type: 'realty.lead.stage_changed';
    leadId: string;
    fromStage: string;
    toStage: string;
}
/**
 * Emitted when a lead crosses the hot threshold — triggers the broker's
 * real-time dossier alert (name · BLTC · source · best-fit · takeover).
 */
export interface RealtyLeadHotEvent extends BaseEvent {
    readonly type: 'realty.lead.hot';
    leadId: string;
    qualScore: number;
    assignedAgentId?: string;
    matchedUnitIds: string[];
}
/** Emitted when a lead opts out — must halt all automated sends. */
export interface RealtyLeadOptedOutEvent extends BaseEvent {
    readonly type: 'realty.lead.opted_out';
    leadId: string;
    whatsappPhone: string;
}
/** Emitted when a verified project is added to the grounding layer. */
export interface RealtyProjectCreatedEvent extends BaseEvent {
    readonly type: 'realty.project.created';
    projectId: string;
    reraNumber?: string;
    locality: string;
}
/** Emitted whenever a unit's availability changes (feeds freshness rules). */
export interface RealtyUnitAvailabilityChangedEvent extends BaseEvent {
    readonly type: 'realty.unit.availability_changed';
    unitId: string;
    projectId: string;
    availability: string;
}
/** Emitted when a verified asset (brochure, floor plan, etc.) is published. */
export interface RealtyAssetPublishedEvent extends BaseEvent {
    readonly type: 'realty.asset.published';
    assetId: string;
    projectId: string;
    assetType: string;
    version: number;
}
/** Emitted when a site visit is booked — moves the lead to VISIT_BOOKED. */
export interface RealtyVisitBookedEvent extends BaseEvent {
    readonly type: 'realty.visit.booked';
    visitId: string;
    leadId: string;
    projectId: string;
    unitId?: string;
    scheduledAt: string;
    assignedAgentId?: string;
}
/** Emitted when the buyer confirms attendance. */
export interface RealtyVisitConfirmedEvent extends BaseEvent {
    readonly type: 'realty.visit.confirmed';
    visitId: string;
    leadId: string;
    scheduledAt: string;
}
/** Emitted when a visit is moved to a new time. */
export interface RealtyVisitRescheduledEvent extends BaseEvent {
    readonly type: 'realty.visit.rescheduled';
    visitId: string;
    leadId: string;
    oldScheduledAt: string;
    newScheduledAt: string;
}
/** Emitted when a visit is cancelled and its slot freed. */
export interface RealtyVisitCancelledEvent extends BaseEvent {
    readonly type: 'realty.visit.cancelled';
    visitId: string;
    leadId: string;
    reason?: string;
}
/** Emitted when a visit completes — moves the lead to VISITED, carries outcome. */
export interface RealtyVisitCompletedEvent extends BaseEvent {
    readonly type: 'realty.visit.completed';
    visitId: string;
    leadId: string;
    projectId: string;
    outcome: string;
}
/** Emitted when a buyer does not show up for a booked visit. */
export interface RealtyVisitNoShowEvent extends BaseEvent {
    readonly type: 'realty.visit.no_show';
    visitId: string;
    leadId: string;
    scheduledAt: string;
}
/**
 * Emitted at each reminder offset (T-24h, T-2h) before a visit. Self-consumed
 * by the notification path to send the WhatsApp reminder template.
 */
export interface RealtyVisitReminderEvent extends BaseEvent {
    readonly type: 'realty.visit.reminder';
    visitId: string;
    leadId: string;
    scheduledAt: string;
    minutesBefore: number;
}
/**
 * Emitted whenever a lead is ingested from any external source (Meta Leadgen,
 * portal email, CSV, CTWA). Carries source metadata for attribution ROI.
 * `merged` is true when the ingest folded into an existing lead (same E.164
 * phone) rather than creating a new one — one buyer, one history.
 */
export interface RealtyLeadIngestedEvent extends BaseEvent {
    readonly type: 'realty.lead.ingested';
    leadId: string;
    source: string;
    subSource?: string;
    listingRef?: string;
    whatsappPhone: string;
    merged: boolean;
}
/** Emitted when a lead is enrolled into a follow-up cadence. */
export interface RealtyCadenceStartedEvent extends BaseEvent {
    readonly type: 'realty.cadence.started';
    enrollmentId: string;
    leadId: string;
    cadenceId: string;
    trigger: string;
}
/** Emitted when a cadence step's template is dispatched (or would be). */
export interface RealtyCadenceStepSentEvent extends BaseEvent {
    readonly type: 'realty.cadence.step_sent';
    enrollmentId: string;
    leadId: string;
    cadenceId: string;
    stepOrder: number;
    templateId: string;
}
/** Emitted when a cadence finishes — either ran out of steps or was stopped. */
export interface RealtyCadenceCompletedEvent extends BaseEvent {
    readonly type: 'realty.cadence.completed';
    enrollmentId: string;
    leadId: string;
    cadenceId: string;
    /** COMPLETED (ran all steps) or STOPPED (halted by a stop_on signal). */
    outcome: string;
    stopReason?: string;
}
/** Emitted when any item is pushed to the broker's notification centre. */
export interface RealtyBrokerAlertEvent extends BaseEvent {
    readonly type: 'realty.broker.alert';
    alertId: string;
    alertType: string;
    leadId?: string;
    title: string;
}
/** Emitted when an AI draft enters the human approval queue (70–89% band). */
export interface RealtyApprovalCreatedEvent extends BaseEvent {
    readonly type: 'realty.approval.created';
    approvalId: string;
    leadId: string;
    conversationId?: string;
    confidence: number;
}
/** Emitted when a broker approves / edits / rejects an AI draft. */
export interface RealtyApprovalResolvedEvent extends BaseEvent {
    readonly type: 'realty.approval.resolved';
    approvalId: string;
    leadId: string;
    outcome: string;
    reviewedBy?: string;
}
/** Emitted when a broker takes a conversation over from the AI (handoff). */
export interface RealtyConversationTakenOverEvent extends BaseEvent {
    readonly type: 'realty.conversation.taken_over';
    conversationId: string;
    leadId?: string;
    owner: string;
    takenOverBy?: string;
}
/**
 * Emitted after the realty AI loop finishes one turn. Carries the routed mode,
 * confidence, and any guardrail violation codes so downstream watchers (the
 * no-ship ledger) can detect a violation that co-occurred with an actual send.
 */
export interface RealtyAiTurnCompletedEvent extends BaseEvent {
    readonly type: 'realty.ai.turn_completed';
    leadId: string;
    conversationId?: string;
    intent: string;
    routeMode: string;
    confidence: number;
    /** Guardrail violation codes fired on the proposed response (empty when clean). */
    violations: string[];
    /** Violation codes that were BLOCK-severity (must never ship autonomously). */
    blockingViolations: string[];
}
/** Emitted when a pilot-migration run is recorded (dry-run or committed). */
export interface RealtyMigrationCompletedEvent extends BaseEvent {
    readonly type: 'realty.migration.completed';
    runId: string;
    kind: string;
    status: string;
    dryRun: boolean;
    created: number;
    merged: number;
    skipped: number;
}
/** Emitted when the evidence-driven autonomy dial changes (OPEN / CLOSE). */
export interface RealtyAutonomyChangedEvent extends BaseEvent {
    readonly type: 'realty.autonomy.changed';
    autonomyEventId: string;
    direction: string;
    fromLevel: string;
    toLevel: string;
    fromThreshold: number;
    toThreshold: number;
    actorType: string;
}
/** Emitted when a no-ship incident is recorded (a hard-fail for the launch gate). */
export interface RealtyNoShipIncidentEvent extends BaseEvent {
    readonly type: 'realty.no_ship.incident';
    incidentId: string;
    kind: string;
    leadId?: string;
    source: string;
}
/** Emitted whenever the launch-readiness gate is evaluated (GO / NO-GO / NOT_READY). */
export interface RealtyLaunchGateEvaluatedEvent extends BaseEvent {
    readonly type: 'realty.launch_gate.evaluated';
    status: string;
    passed: number;
    failed: number;
    insufficient: number;
}
/** Emitted after a nightly aggregation run persists corridor patterns. */
export interface RealtyIntelligenceAggregatesGeneratedEvent extends BaseEvent {
    readonly type: 'realty.intelligence.aggregates_generated';
    /** How many opted-in businesses were included in the run. */
    businessCount: number;
    /** How many aggregate rows were written across all corridors/metrics. */
    aggregateCount: number;
    /** Distinct corridors covered this run. */
    corridorCount: number;
    periodStart: string;
    periodEnd: string;
}
/** Emitted when a business consents to contribute to the intelligence layer. */
export interface RealtyIntelligenceOptedInEvent extends BaseEvent {
    readonly type: 'realty.intelligence.opted_in';
}
/** Emitted when a business withdraws intelligence consent. */
export interface RealtyIntelligenceOptedOutEvent extends BaseEvent {
    readonly type: 'realty.intelligence.opted_out';
}
/** A consented lead was syndicated to a counterparty (state → OFFERED). */
export interface RealtySyndicationOfferedEvent extends BaseEvent {
    readonly type: 'realty.syndication.offered';
    syndicationId: string;
    leadId: string;
    fromBusinessId: string;
    toBusinessId: string;
}
/** The counterparty accepted the syndication (state → ACCEPTED). */
export interface RealtySyndicationAcceptedEvent extends BaseEvent {
    readonly type: 'realty.syndication.accepted';
    syndicationId: string;
    leadId: string;
    toBusinessId: string;
}
/** A syndicated deal closed; the commission pool and platform fee are settled. */
export interface RealtySyndicationClosedEvent extends BaseEvent {
    readonly type: 'realty.syndication.closed';
    syndicationId: string;
    leadId: string;
    /** Commission pool in paise. */
    commissionPoolPaise: number;
    /** Platform fee in paise. */
    platformFeePaise: number;
}
/** A syndication was contested by either side (state → DISPUTED). */
export interface RealtySyndicationDisputedEvent extends BaseEvent {
    readonly type: 'realty.syndication.disputed';
    syndicationId: string;
    leadId: string;
    reason: string;
}
/** A business changed its subscription tier (upgrade/downgrade). */
export interface RealtyPlanChangedEvent extends BaseEvent {
    readonly type: 'realty.plan.changed';
    fromPlan: string;
    toPlan: string;
}
/** A lead was counted against the plan's monthly allotment. */
export interface RealtyLeadUsageRecordedEvent extends BaseEvent {
    readonly type: 'realty.lead_usage.recorded';
    leadsUsed: number;
    monthlyLeadLimit: number | null;
    /** True when this lead fell beyond the included allotment (billed as overage). */
    overage: boolean;
}
/** The plan's monthly lead limit was reached (soft cap — an upgrade is prompted). */
export interface RealtyLeadLimitReachedEvent extends BaseEvent {
    readonly type: 'realty.lead_limit.reached';
    plan: string;
    monthlyLeadLimit: number;
    leadsUsed: number;
}
/** A consent was granted or revoked for a buyer phone (DPDPA ledger). */
export interface RealtyConsentRecordedEvent extends BaseEvent {
    readonly type: 'realty.consent.recorded';
    phone: string;
    consentType: string;
    granted: boolean;
    channel: string;
}
/** A buyer's data was erased (anonymized) on request or by retention policy. */
export interface RealtyLeadErasedEvent extends BaseEvent {
    readonly type: 'realty.lead.erased';
    leadId: string;
    /** "REQUEST" (right to erasure) | "RETENTION" (auto-anonymize). */
    reason: string;
    /** How many message rows had their sender info anonymized. */
    messagesAnonymized: number;
}
/** A retention sweep finished for a business. */
export interface RealtyRetentionRunEvent extends BaseEvent {
    readonly type: 'realty.retention.run';
    leadsAnonymized: number;
    messagesAnonymized: number;
    retentionMonths: number;
}
export type DomainEvent = MessageReceivedEvent | MessageSentEvent | MessageFailedEvent | MessageStoredEvent | ConversationCreatedEvent | ConversationResolvedEvent | ConversationEscalatedEvent | ConversationStatusChangedEvent | ConversationAssignedEvent | TeamMemberRemovedEvent | AIIntentClassifiedEvent | AIResponseGeneratedEvent | AIResponseApprovedEvent | AIResponseRejectedEvent | TaskCreatedEvent | TaskAssignedEvent | TaskResolvedEvent | OrderCreatedEvent | OrderConfirmedEvent | OrderCancelledEvent | OrderPackedEvent | OrderPaidEvent | OrderShippedEvent | OrderDeliveredEvent | OrderReturnedEvent | PaymentCreatedEvent | PaymentSuccessEvent | PaymentFailedEvent | PaymentRefundEvent | InvoiceCreatedEvent | InvoiceIssuedEvent | InvoicePaidEvent | BookingCreatedEvent | BookingCancelledEvent | BookingConfirmedEvent | BookingRescheduledEvent | BookingCompletedEvent | BookingReminderEvent | ClientProfileUpdatedEvent | ContactTaggedEvent | CannedResponseUsedEvent | SlaBreachedEvent | SlaEscalatedEvent | CatalogItemCreatedEvent | CatalogItemUpdatedEvent | CatalogStockLowEvent | CatalogStockOutEvent | NotificationQueuedEvent | NotificationSentEvent | NotificationDeliveredEvent | NotificationFailedEvent | NotificationSkippedEvent | RealtyLeadCreatedEvent | RealtyLeadQualifiedEvent | RealtyLeadStageChangedEvent | RealtyLeadHotEvent | RealtyLeadOptedOutEvent | RealtyProjectCreatedEvent | RealtyUnitAvailabilityChangedEvent | RealtyAssetPublishedEvent | RealtyVisitBookedEvent | RealtyVisitConfirmedEvent | RealtyVisitRescheduledEvent | RealtyVisitCancelledEvent | RealtyVisitCompletedEvent | RealtyVisitNoShowEvent | RealtyVisitReminderEvent | RealtyLeadIngestedEvent | RealtyCadenceStartedEvent | RealtyCadenceStepSentEvent | RealtyCadenceCompletedEvent | RealtyBrokerAlertEvent | RealtyApprovalCreatedEvent | RealtyApprovalResolvedEvent | RealtyConversationTakenOverEvent | RealtyAiTurnCompletedEvent | RealtyMigrationCompletedEvent | RealtyAutonomyChangedEvent | RealtyNoShipIncidentEvent | RealtyLaunchGateEvaluatedEvent | RealtySyndicationOfferedEvent | RealtySyndicationAcceptedEvent | RealtySyndicationClosedEvent | RealtySyndicationDisputedEvent | RealtyIntelligenceAggregatesGeneratedEvent | RealtyIntelligenceOptedInEvent | RealtyIntelligenceOptedOutEvent | RealtyPlanChangedEvent | RealtyLeadUsageRecordedEvent | RealtyLeadLimitReachedEvent | RealtyConsentRecordedEvent | RealtyLeadErasedEvent | RealtyRetentionRunEvent;
/** Infer the event type from the `type` discriminant */
export type EventType = DomainEvent['type'];
//# sourceMappingURL=index.d.ts.map