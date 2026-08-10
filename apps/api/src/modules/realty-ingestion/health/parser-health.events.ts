import type { RealtyParserHealthStatus } from '@prisma/client';

/**
 * Parser-health events are platform-ops signals (global parser code, no tenant
 * data), so they do NOT extend BaseEvent (no businessId). Listeners: analytics
 * dashboards and the ops-notification channel that pages when a portal drifts.
 */

export interface RealtyParserHealthCheckedEvent {
  readonly type: 'realty.parser.health_checked';
  id: string;
  timestamp: string;
  correlationId: string;
  portal: string;
  status: RealtyParserHealthStatus;
  sampleCount: number;
  passCount: number;
  failCount: number;
}

export interface RealtyParserDegradedEvent {
  readonly type: 'realty.parser.degraded';
  id: string;
  timestamp: string;
  correlationId: string;
  portal: string;
  status: RealtyParserHealthStatus;
  failCount: number;
  emptyCount: number;
  /** Which expected fields the parser stopped extracting (drift signature). */
  missingFields: string[];
}
