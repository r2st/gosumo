// GoSumo Realty — Micro-Market Intelligence (L1) types.
//
// Mirrors the backend realty-intelligence module's response shapes. Kept local (not
// imported from @gosumo/shared) so the web app builds independently, per the
// frontend convention documented in apps/web/CLAUDE.md.

export type IntelligenceMetricType =
  | 'CADENCE_CONVERSION'
  | 'OBJECTION_FREQUENCY'
  | 'PRICE_ELASTICITY'
  | 'SOURCE_QUALITY'
  | 'SEASONAL_VELOCITY';

// ── Metric-value payloads (the JSONB `metricValue` per aggregate) ───────────────

export interface CadenceConversionValue {
  total: number;
  converted: number;
  conversionRate: number; // 0..1
  medianDaysToConvert: number | null;
  buckets: Array<{ label: string; converted: number; share: number }>;
}

export interface ObjectionFrequencyValue {
  totalObjections: number;
  topObjections: Array<{ label: string; count: number; share: number }>;
  byConfig: Array<{ config: string; topObjection: string; count: number }>;
}

export interface QuantileTriple {
  p25: number;
  p50: number;
  p75: number;
}

export interface PriceElasticityValue {
  withBudget: number;
  budgetMinPaise: QuantileTriple | null;
  budgetMaxPaise: QuantileTriple | null;
  recommendedBandPaise: { low: number; high: number } | null;
}

export interface SourceQualityValue {
  sources: Array<{
    source: string;
    leads: number;
    qualifiedRate: number; // 0..1
    visitRate: number; // 0..1
    avgQualScore: number;
  }>;
}

export interface SeasonalVelocityValue {
  months: Array<{
    month: string; // YYYY-MM
    leads: number;
    converted: number;
    conversionRate: number; // 0..1
  }>;
}

// ── API response shapes ─────────────────────────────────────────────────────────

/** One stored corridor aggregate. `metricValue` is one of the payloads above. */
export interface IntelligenceAggregate {
  id: string;
  corridor: string;
  metricType: IntelligenceMetricType;
  metricValue: unknown;
  sampleSize: number;
  minNThreshold: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
}

/** GET /realty/intelligence/corridors */
export interface CorridorsResponse {
  corridors: string[];
}

/** GET /realty/intelligence/corridor-priors?corridor=… */
export interface CorridorPriorsResponse {
  corridor: string;
  priors: IntelligenceAggregate[];
  promptContext: string | null;
}

/** GET /realty/intelligence/source-quality — the tenant's own per-source ROI. */
export interface SourceQualityReport {
  businessId: string;
  totalLeads: number;
  generatedAt: string;
  sources: SourceQualityValue['sources'];
}

/** GET/POST /realty/intelligence/opt-in|opt-out */
export interface OptInStatus {
  optIn: boolean;
}
