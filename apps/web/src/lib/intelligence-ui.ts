// GoSumo Realty — presentation helpers for the Micro-Market Intelligence page.
// Parses typed metric payloads out of aggregates and provides bilingual labels for
// the objection / cadence / source vocabularies the backend emits as fixed codes.

import type { UiLang } from '@/lib/i18n';
import type {
  IntelligenceAggregate,
  IntelligenceMetricType,
  CadenceConversionValue,
  ObjectionFrequencyValue,
  PriceElasticityValue,
  SeasonalVelocityValue,
} from '@/lib/intelligence-types';

/** Pull the typed payload for a metric out of a list of aggregates (or null). */
export function pickMetric<T>(
  aggregates: IntelligenceAggregate[] | undefined,
  metricType: IntelligenceMetricType,
): T | null {
  const row = aggregates?.find((a) => a.metricType === metricType);
  return row ? (row.metricValue as T) : null;
}

export const getCadence = (a?: IntelligenceAggregate[]) =>
  pickMetric<CadenceConversionValue>(a, 'CADENCE_CONVERSION');
export const getObjections = (a?: IntelligenceAggregate[]) =>
  pickMetric<ObjectionFrequencyValue>(a, 'OBJECTION_FREQUENCY');
export const getPrice = (a?: IntelligenceAggregate[]) =>
  pickMetric<PriceElasticityValue>(a, 'PRICE_ELASTICITY');
export const getSeasonal = (a?: IntelligenceAggregate[]) =>
  pickMetric<SeasonalVelocityValue>(a, 'SEASONAL_VELOCITY');

// ── Objection categories (backend OBJECTION_RULES labels) ───────────────────────

const OBJECTION_LABELS: Record<UiLang, Record<string, string>> = {
  en: {
    PRICE_TOO_HIGH: 'Price too high',
    LOAN_FINANCE: 'Loan / finance',
    POSSESSION_DELAY: 'Possession delay',
    LOCATION: 'Location',
    SIZE_LAYOUT: 'Size / layout',
    LEGAL_RERA: 'Legal / RERA',
    AMENITIES: 'Amenities',
    OTHER: 'Other',
  },
  hi: {
    PRICE_TOO_HIGH: 'कीमत ज़्यादा',
    LOAN_FINANCE: 'लोन / फाइनेंस',
    POSSESSION_DELAY: 'कब्ज़े में देरी',
    LOCATION: 'लोकेशन',
    SIZE_LAYOUT: 'साइज़ / ले-आउट',
    LEGAL_RERA: 'लीगल / RERA',
    AMENITIES: 'सुविधाएँ',
    OTHER: 'अन्य',
  },
};

export function objectionLabel(label: string, lang: UiLang): string {
  return OBJECTION_LABELS[lang]?.[label] ?? OBJECTION_LABELS.en[label] ?? label;
}

// ── Cadence conversion buckets (time-to-visit) ──────────────────────────────────

const BUCKET_LABELS: Record<UiLang, Record<string, string>> = {
  en: {
    SAME_DAY: 'Same day',
    WEEK_1: 'Week 1',
    WEEK_2: 'Week 2',
    MONTH_1: 'Month 1',
    LATER: 'Later',
  },
  hi: {
    SAME_DAY: 'उसी दिन',
    WEEK_1: 'हफ़्ता 1',
    WEEK_2: 'हफ़्ता 2',
    MONTH_1: 'महीना 1',
    LATER: 'बाद में',
  },
};

export function bucketLabel(label: string, lang: UiLang): string {
  return BUCKET_LABELS[lang]?.[label] ?? BUCKET_LABELS.en[label] ?? label;
}

// ── Lead sources (LeadSource enum) ──────────────────────────────────────────────

const SOURCE_LABELS: Record<UiLang, Record<string, string>> = {
  en: {
    PORTAL: 'Portal',
    META_LEAD_AD: 'Meta Ad',
    CTWA: 'WhatsApp',
    IVR: 'IVR',
    REFERRAL: 'Referral',
    CSV: 'CSV',
    WALK_IN: 'Walk-in',
    EXCHANGE_INBOUND: 'Exchange',
    MANUAL: 'Manual',
  },
  hi: {
    PORTAL: 'पोर्टल',
    META_LEAD_AD: 'मेटा विज्ञापन',
    CTWA: 'व्हाट्सऐप',
    IVR: 'IVR',
    REFERRAL: 'रेफ़रल',
    CSV: 'CSV',
    WALK_IN: 'वॉक-इन',
    EXCHANGE_INBOUND: 'एक्सचेंज',
    MANUAL: 'मैन्युअल',
  },
};

export function sourceLabel(source: string, lang: UiLang): string {
  return SOURCE_LABELS[lang]?.[source] ?? SOURCE_LABELS.en[source] ?? source;
}

// ── Month formatting (YYYY-MM) ──────────────────────────────────────────────────

const MONTHS: Record<UiLang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: ['जन', 'फ़र', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुल', 'अग', 'सित', 'अक्तू', 'नव', 'दिस'],
};

/** "2026-07" → "Jul '26" / "जुल '26". */
export function monthLabel(ym: string, lang: UiLang): string {
  const [y, m] = ym.split('-');
  const idx = Number(m) - 1;
  const name = MONTHS[lang]?.[idx] ?? MONTHS.en[idx] ?? m;
  return `${name} '${(y ?? '').slice(2)}`;
}

/** Percentage from a 0..1 ratio, e.g. 0.42 → "42%". */
export function ratioPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
