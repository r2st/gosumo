import type { BadgeTone } from '@/components/ui/badge';
import type { SyndicationState, SettlementState, ResaleListingStatus } from '@/lib/realty-types';

export const SYNDICATION_STATE_TONE: Record<SyndicationState, BadgeTone> = {
  OFFERED: 'info',
  ACCEPTED: 'primary',
  VISIT: 'warning',
  CLOSED: 'success',
  EXPIRED: 'neutral',
  DISPUTED: 'danger',
};

export const SETTLEMENT_TONE: Record<SettlementState, BadgeTone> = {
  UNSETTLED: 'neutral',
  PENDING: 'warning',
  SETTLED: 'success',
  REVERSED: 'danger',
};

export const RESALE_STATUS_TONE: Record<ResaleListingStatus, BadgeTone> = {
  ACTIVE: 'success',
  UNDER_OFFER: 'warning',
  SOLD: 'neutral',
  WITHDRAWN: 'neutral',
};

/** A 0–100 score → a traffic-light tone for reliability + match displays. */
export function scoreTone(score: number): BadgeTone {
  if (score >= 75) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

/** Short, human counterparty label from a business UUID (until a name lookup lands). */
export function shortBusinessId(id: string): string {
  return id.slice(0, 8);
}
