import { PrismaClient } from '@prisma/client';
export { PrismaClient } from '@prisma/client';
export type { businesses, team_members, clients, consumer_users, channel_accounts, channel_contacts, conversations, messages, file_uploads, notification_templates, webhook_events, business_rules, ai_decisions, ai_precedents, vector_embeddings_metadata, tasks, catalog_categories, catalog_items, catalog_variants, catalog_packages, orders, payments, refunds, shipping_addresses, shipping_options, shipments, bookings, campaigns, analytics_events, audit_logs, ai_quality_metrics, payment_reconciliation_runs, payment_discrepancies, notification_template_versions, data_retention_policies, data_archive_records, data_retention_runs, } from '@prisma/client';
export { ChannelType, MessageDirection, MessageType, MessageStatus, ConversationStatus, TeamMemberRole, TeamMemberStatus, TaskStatus, TaskType, TaskPriority, AiDecisionOutcome, AiDecisionType, RuleType, RuleTrigger, OrderStatus, PaymentStatus, PaymentMethod, PaymentGateway, RefundStatus, BookingStatus, ShipmentStatus, CampaignStatus, CampaignType, CatalogItemType, EmbeddingEntityType, NotificationTemplateChannel, AuditAction, FileUploadType, AnalyticsEventCategory, AiQualityBucket, ReconciliationRunStatus, PaymentDiscrepancyType, PaymentDiscrepancyStatus, PaymentDiscrepancySeverity, TemplateVersionState, TemplateValidationState, RetentionDataClass, RetentionActionKind, DataExportJobStatus, DataExportArchiveFormat, ConversationTagSource, CannedResponseApprovalStatus, ContactMergeStrategy, NotificationDigestFrequency, } from '@prisma/client';
/**
 * Application-scoped Prisma client singleton.
 *
 * In NestJS, inject via PrismaService (which wraps this).
 * In scripts/seeds, import directly.
 *
 * The singleton pattern prevents connection pool exhaustion
 * during hot-reload in development (Next.js / ts-node-dev).
 */
declare global {
    var __prisma: PrismaClient | undefined;
}
export declare const prisma: PrismaClient;
//# sourceMappingURL=index.d.ts.map