import { PrismaClient } from '@prisma/client';

// Re-export the generated client and all its types
export { PrismaClient } from '@prisma/client';
export type {
  // Platform layer
  businesses,
  team_members,
  clients,
  consumer_users,
  // Channel & messaging layer
  channel_accounts,
  channel_contacts,
  conversations,
  messages,
  file_uploads,
  notification_templates,
  webhook_events,
  // Intelligence layer
  business_rules,
  ai_decisions,
  ai_precedents,
  vector_embeddings_metadata,
  tasks,
  // Commerce layer
  catalog_categories,
  catalog_items,
  catalog_variants,
  catalog_packages,
  orders,
  payments,
  refunds,
  shipping_addresses,
  shipping_options,
  shipments,
  bookings,
  // Engagement layer
  campaigns,
  // Operations layer
  analytics_events,
  audit_logs,
  // Production hardening layer
  ai_quality_metrics,
  payment_reconciliation_runs,
  payment_discrepancies,
  notification_template_versions,
  data_retention_policies,
  data_archive_records,
  data_retention_runs,
} from '@prisma/client';

// Re-export all Prisma enums
export {
  ChannelType,
  MessageDirection,
  MessageType,
  MessageStatus,
  ConversationStatus,
  TeamMemberRole,
  TeamMemberStatus,
  TaskStatus,
  TaskType,
  TaskPriority,
  AiDecisionOutcome,
  AiDecisionType,
  RuleType,
  RuleTrigger,
  OrderStatus,
  PaymentStatus,
  PaymentMethod,
  PaymentGateway,
  RefundStatus,
  BookingStatus,
  ShipmentStatus,
  CampaignStatus,
  CampaignType,
  CatalogItemType,
  EmbeddingEntityType,
  NotificationTemplateChannel,
  AuditAction,
  FileUploadType,
  AnalyticsEventCategory,
  // Production hardening: AI quality, payment reconciliation, template
  // versioning, data retention.
  AiQualityBucket,
  ReconciliationRunStatus,
  PaymentDiscrepancyType,
  PaymentDiscrepancyStatus,
  PaymentDiscrepancySeverity,
  TemplateVersionState,
  TemplateValidationState,
  RetentionDataClass,
  RetentionActionKind,
  // R84: export archives, tag provenance, template approval, contact merge,
  // per-business notification rules.
  DataExportJobStatus,
  DataExportArchiveFormat,
  ConversationTagSource,
  CannedResponseApprovalStatus,
  ContactMergeStrategy,
  NotificationDigestFrequency,
  // R86: PostgreSQL-backed knowledge base.
  KnowledgeArticleStatus,
  // R87: operator alerting.
  OperatorAlertStatus,
} from '@prisma/client';

// ─────────────────────────────────────────────
// Singleton PrismaClient for use in NestJS
// ─────────────────────────────────────────────

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
  // Allow the global variable to persist across hot-reloads
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log:
      process.env['NODE_ENV'] === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  global.__prisma = prisma;
}
