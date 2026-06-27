/**
 * Types for the Analytics deep-dives, Settings surfaces and Notification Center.
 * Extends the base types in ./types (which the scaffolding generated) with the
 * additional shapes documented in API_DESIGN.md but not yet defined there.
 */
import type { ChannelType, ISODate, UUID } from './types';

// Roles — the platform supports a read-only VIEWER in addition to the base set.
export type Role = 'OWNER' | 'MANAGER' | 'STAFF' | 'VIEWER';
export type AssignableRole = 'MANAGER' | 'STAFF' | 'VIEWER';

export type Granularity = 'HOUR' | 'DAY' | 'WEEK';

export interface DateRangeParams {
  from?: string;
  to?: string;
  granularity?: Granularity;
  channelId?: string;
}

// ── Analytics: AI autonomy ──────────────────────────────────────────────────
export interface AutonomyReport {
  summary: { autonomyRate: number; trend: number; totalDecisions: number };
  timeSeries: Array<{ date: string; autonomyRate: number; autoExecuted: number; reviewed: number; escalated: number }>;
  intentBreakdown: Array<{ intent: string; count: number; autonomyRate: number; avgConfidence: number }>;
  confidenceDistribution: Array<{ bucket: string; count: number }>;
  topEscalationReasons: Array<{ reason: string; count: number }>;
}

// ── Analytics: clients ──────────────────────────────────────────────────────
export interface ClientReport {
  summary: { total: number; newClients: number; returning: number; avgLtv: number; churnRiskHigh: number };
  acquisitionTimeSeries: Array<{ date: string; newClients: number }>;
  churnRiskBreakdown: { low: number; medium: number; high: number };
  sentimentDistribution: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  channelPreferences: Record<string, number>;
}

// Agent leaderboard rows live on the conversation report.
export interface AgentPerformance {
  userId: UUID;
  name: string;
  resolved: number;
  avgResolutionTimeMs: number;
  tasksApproved: number;
  tasksRejected: number;
}

// Fulfillment mix lives on the revenue report.
export interface FulfillmentBreakdown {
  [key: string]: { orders: number; revenue: number };
}

// ── Settings: business settings ─────────────────────────────────────────────
export interface DaySchedule {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
  breakStart?: string;
  breakEnd?: string;
}

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type OfficeHours = Partial<Record<WeekDay, DaySchedule>>;

export interface BusinessSettings {
  aiAutonomyLevel: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  aiAutoReplyEnabled: boolean;
  aiConfidenceThreshold: number;
  aiAutoExecuteThreshold: number;
  officeHoursEnabled: boolean;
  officeHours: OfficeHours;
  officeHoursTimezone: string;
  outsideHoursMessage: string;
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
  notificationEmail?: string;
  notificationPhone?: string;
  defaultGreeting?: string;
  defaultSignoff?: string;
  messageDeliveryDelayMs: number;
  hitlEnabled: boolean;
  hitlAutoEscalateAfterMs: number;
  razorpayEnabled: boolean;
  codEnabled: boolean;
  bookingEnabled: boolean;
  defaultSlotDurationMinutes: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  updatedAt: ISODate;
}

// ── Settings: team ──────────────────────────────────────────────────────────
export interface TeamMember {
  id: UUID;
  email: string;
  name: string;
  role: Role;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  avatarUrl?: string;
  lastActiveAt?: ISODate;
  createdAt: ISODate;
}

export interface InviteTeamMemberRequest {
  email: string;
  name: string;
  role: AssignableRole;
}

// ── Settings: channels ──────────────────────────────────────────────────────
export type ChannelStatus = 'CONNECTED' | 'DISCONNECTED' | 'PENDING' | 'ERROR' | 'RATE_LIMITED';

export interface Channel {
  id: UUID;
  businessId: UUID;
  type: ChannelType;
  displayName: string;
  status: ChannelStatus;
  accountId: string;
  webhookUrl: string;
  metadata: Record<string, unknown>;
  connectedAt?: ISODate;
  lastMessageAt?: ISODate;
  errorMessage?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── Settings: AI config ─────────────────────────────────────────────────────
export interface ConfidenceThresholds {
  autoExecute: number;
  draftReview: number;
}

// ── Settings: subscription / billing ────────────────────────────────────────
export type SubscriptionPlan = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED';

export interface UsageMeter {
  key: string;
  label: string;
  used: number;
  limit: number | null; // null => unlimited
  unit: string;
}

export interface SubscriptionInfo {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  trialEndsAt?: ISODate;
  currentPeriodEnd?: ISODate;
  priceMonthlyPaise: number;
  usage: UsageMeter[];
}

// ── Settings: Google Calendar integration ───────────────────────────────────
export interface CalendarIntegration {
  connected: boolean;
  accountEmail?: string;
  calendarId?: string;
  lastSyncedAt?: ISODate;
  syncEnabled: boolean;
}

// ── Notifications ───────────────────────────────────────────────────────────
export type NotificationType =
  | 'TASK_CREATED'
  | 'TASK_ASSIGNED'
  | 'CONVERSATION_ESCALATED'
  | 'PAYMENT_RECEIVED'
  | 'BOOKING_CREATED'
  | 'CHANNEL_ERROR'
  | 'SYSTEM';

export interface AppNotification {
  id: UUID;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  actionUrl?: string;
  createdAt: ISODate;
}
