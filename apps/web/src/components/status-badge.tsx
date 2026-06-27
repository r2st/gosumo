import { Badge, type BadgeTone } from '@/components/ui/badge';
import { humanizeEnum } from '@/lib/format';

const TONE_MAP: Record<string, BadgeTone> = {
  // Conversation
  OPEN: 'info',
  PENDING: 'warning',
  PENDING_HUMAN: 'warning',
  RESOLVED: 'success',
  ESCALATED: 'danger',
  BOT_HANDLING: 'primary',
  SNOOZED: 'neutral',
  // HITL
  IN_PROGRESS: 'info',
  EXPIRED: 'danger',
  // Priority
  LOW: 'neutral',
  NORMAL: 'info',
  MEDIUM: 'warning',
  HIGH: 'warning',
  URGENT: 'danger',
  // Orders
  DRAFT: 'neutral',
  PENDING_PAYMENT: 'warning',
  PAID: 'success',
  PROCESSING: 'info',
  READY_FOR_PICKUP: 'info',
  SHIPPED: 'primary',
  DELIVERED: 'success',
  CANCELLED: 'danger',
  REFUNDED: 'neutral',
  PARTIALLY_REFUNDED: 'neutral',
  // Bookings
  CONFIRMED: 'success',
  COMPLETED: 'success',
  NO_SHOW: 'danger',
  RESCHEDULED: 'warning',
  // Payments
  AUTHORIZED: 'info',
  CAPTURED: 'success',
  FAILED: 'danger',
  // Churn / sentiment
  VERY_NEGATIVE: 'danger',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
  POSITIVE: 'success',
  VERY_POSITIVE: 'success',
};

export function StatusBadge({ value, className }: { value: string; className?: string }) {
  return (
    <Badge tone={TONE_MAP[value] ?? 'neutral'} className={className}>
      {humanizeEnum(value)}
    </Badge>
  );
}
