// GoSumo Realty — shared UI helpers for the lead / inventory surfaces.
// Keeps card, board, dossier, and inventory components visually consistent.

import type { BadgeTone } from '@/components/ui/badge';
import { paiseToCompactRupees } from '@/lib/format';
import type {
  BltcProfile,
  Lead,
  LeadSource,
  LeadStage,
  LeadTemperature,
  ProjectStatus,
  RealtyUnit,
  UnitAvailability,
} from '@/lib/realty-types';

// ── Project status ────────────────────────────────────────────────────────────

/** Short status chip label — the compact form used on cards. */
export const PROJECT_STATUS_SHORT: Record<ProjectStatus, string> = {
  PRELAUNCH: 'Pre-launch',
  UC: 'UC',
  RTM: 'RTM',
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  PRELAUNCH: 'info',
  UC: 'warning',
  RTM: 'success',
};

/** A gradient per status gives each project's photo-placeholder a distinct tint. */
export const PROJECT_STATUS_GRADIENT: Record<ProjectStatus, string> = {
  PRELAUNCH: 'from-sky-100 to-indigo-100',
  UC: 'from-amber-100 to-orange-100',
  RTM: 'from-emerald-100 to-teal-100',
};

// ── Unit availability ─────────────────────────────────────────────────────────

/** AVAILABLE=green, HELD=amber, SOLD=red, UNVERIFIED=gray (blueprint §6). */
export const UNIT_AVAILABILITY_TONE: Record<UnitAvailability, BadgeTone> = {
  AVAILABLE: 'success',
  HELD: 'warning',
  SOLD: 'danger',
  UNVERIFIED: 'neutral',
};

export const UNIT_AVAILABILITY_LABEL: Record<UnitAvailability, string> = {
  AVAILABLE: 'Available',
  HELD: 'On hold',
  SOLD: 'Sold',
  UNVERIFIED: 'Unverified',
};

// ── Lead temperature ────────────────────────────────────────────────────────

export const TEMPERATURE_TONE: Record<LeadTemperature, BadgeTone> = {
  HOT: 'danger',
  WARM: 'warning',
  COLD: 'info',
  JUNK: 'neutral',
};

/** Left-accent border colour for a lead card, keyed off temperature. */
export const TEMPERATURE_BORDER: Record<LeadTemperature, string> = {
  HOT: 'border-l-rose-500',
  WARM: 'border-l-amber-400',
  COLD: 'border-l-sky-400',
  JUNK: 'border-l-slate-300',
};

// ── Lead source ─────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<LeadSource, string> = {
  PORTAL: 'Portal',
  META_LEAD_AD: 'Meta Ad',
  CTWA: 'WhatsApp',
  IVR: 'IVR',
  REFERRAL: 'Referral',
  CSV: 'CSV',
  WALK_IN: 'Walk-in',
  EXCHANGE_INBOUND: 'Exchange',
  MANUAL: 'Manual',
};

const SOURCE_TONE: Record<LeadSource, BadgeTone> = {
  PORTAL: 'info',
  META_LEAD_AD: 'primary',
  CTWA: 'success',
  IVR: 'neutral',
  REFERRAL: 'primary',
  CSV: 'neutral',
  WALK_IN: 'warning',
  EXCHANGE_INBOUND: 'info',
  MANUAL: 'neutral',
};

/** Friendly source label — prefers the portal sub-source (e.g. "99acres") when present. */
export function sourceLabel(lead: Pick<Lead, 'source' | 'subSource'>): string {
  return lead.subSource?.trim() || SOURCE_LABELS[lead.source] || 'Unknown';
}

export function sourceTone(lead: Pick<Lead, 'source'>): BadgeTone {
  return SOURCE_TONE[lead.source] ?? 'neutral';
}

// ── Budget ──────────────────────────────────────────────────────────────────

/** Compact budget range from a BLTC profile, e.g. "₹80.00L–₹1.20Cr", or null if unknown. */
export function budgetLabel(bltc: Pick<BltcProfile, 'budgetMinPaise' | 'budgetMaxPaise'>): string | null {
  const { budgetMinPaise, budgetMaxPaise } = bltc;
  if (budgetMinPaise == null && budgetMaxPaise == null) return null;
  if (budgetMinPaise != null && budgetMaxPaise != null) {
    return `${paiseToCompactRupees(budgetMinPaise)}–${paiseToCompactRupees(budgetMaxPaise)}`;
  }
  return paiseToCompactRupees(budgetMaxPaise ?? budgetMinPaise);
}

// ── BLTC completion (Budget · Location · Timeline · Config) ──────────────────

export interface BltcComponent {
  key: 'B' | 'L' | 'T' | 'C';
  label: string;
  filled: boolean;
  value: string;
}

export function bltcComponents(bltc: BltcProfile): BltcComponent[] {
  const budget = budgetLabel(bltc);
  return [
    { key: 'B', label: 'Budget', filled: budget != null, value: budget ?? 'Not shared' },
    {
      key: 'L',
      label: 'Location',
      filled: bltc.localities.length > 0,
      value: bltc.localities.length > 0 ? bltc.localities.join(', ') : 'Not shared',
    },
    {
      key: 'T',
      label: 'Timeline',
      filled: bltc.timelineMonths != null,
      value: bltc.timelineMonths != null ? `${bltc.timelineMonths} months` : 'Not shared',
    },
    { key: 'C', label: 'Config', filled: !!bltc.config, value: bltc.config ?? 'Not shared' },
  ];
}

export interface BltcCompletion {
  filled: number;
  total: number;
  pct: number;
  /** confirmed = all four captured (green); partial = some (amber); empty = none. */
  state: 'confirmed' | 'partial' | 'empty';
}

export function bltcCompletion(bltc: BltcProfile): BltcCompletion {
  const parts = bltcComponents(bltc);
  const filled = parts.filter((p) => p.filled).length;
  const total = parts.length;
  const pct = Math.round((filled / total) * 100);
  const state = filled === total ? 'confirmed' : filled > 0 ? 'partial' : 'empty';
  return { filled, total, pct, state };
}

/** Tailwind fill colour for a BLTC completion bar. */
export const BLTC_FILL: Record<BltcCompletion['state'], string> = {
  confirmed: 'bg-emerald-500',
  partial: 'bg-amber-400',
  empty: 'bg-muted-foreground/30',
};

// ── Unit match score ──────────────────────────────────────────────────────────

/** Left-border colour for a matched-unit card: green ≥85%, amber ≥70%, else slate. */
export function matchBorder(fitScore: number): string {
  if (fitScore >= 85) return 'border-l-emerald-500';
  if (fitScore >= 70) return 'border-l-amber-400';
  return 'border-l-muted-foreground/30';
}

export function matchTone(fitScore: number): BadgeTone {
  if (fitScore >= 85) return 'success';
  if (fitScore >= 70) return 'warning';
  return 'neutral';
}

// ── Inventory: config range, price range, freshness ──────────────────────────

/** Extract the BHK number from a config string like "2BHK" or "3 BHK". */
function bhkOf(config: string): number | null {
  const m = config.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Config range across units, e.g. "1–3 BHK", "2 BHK", or null. */
export function configRange(units: Pick<RealtyUnit, 'config'>[]): string | null {
  const bhks = units.map((u) => bhkOf(u.config)).filter((n): n is number => n != null);
  if (bhks.length === 0) return null;
  const min = Math.min(...bhks);
  const max = Math.max(...bhks);
  return min === max ? `${min} BHK` : `${min}–${max} BHK`;
}

/** Price range across units in compact INR, falling back to the project price band. */
export function unitPriceRange(
  units: Pick<RealtyUnit, 'allInPricePaise'>[],
  fallback: { min: number | null; max: number | null },
): string | null {
  const prices = units.map((u) => u.allInPricePaise).filter((p) => p > 0);
  if (prices.length > 0) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return min === max ? paiseToCompactRupees(min) : `${paiseToCompactRupees(min)}–${paiseToCompactRupees(max)}`;
  }
  if (fallback.min != null || fallback.max != null) {
    return budgetLabel({ budgetMinPaise: fallback.min, budgetMaxPaise: fallback.max });
  }
  return null;
}

export function availableCount(units: Pick<RealtyUnit, 'availability'>[]): number {
  return units.filter((u) => u.availability === 'AVAILABLE').length;
}

export interface Freshness {
  label: string;
  /** true past the 24h freshness window (blueprint §14). */
  stale: boolean;
  tone: BadgeTone;
}

/**
 * Freshness indicator from a "verified at" timestamp against the 24-hour rule:
 * "Verified 2h ago" (blue) inside the window, "Stale 26h" (red) beyond it.
 */
export function freshness(verifiedAt: string | null | undefined): Freshness | null {
  if (!verifiedAt) return null;
  const then = new Date(verifiedAt).getTime();
  if (Number.isNaN(then)) return null;
  const hours = Math.max(0, Math.round((Date.now() - then) / 3_600_000));
  if (hours < 24) {
    const label = hours <= 0 ? 'Verified now' : `Verified ${hours}h ago`;
    return { label, stale: false, tone: 'info' };
  }
  return { label: `Stale ${hours}h`, stale: true, tone: 'danger' };
}

/** Most recent verified-at across a project's available units — the basis for the freshness chip. */
export function latestVerifiedAt(units: Pick<RealtyUnit, 'availability' | 'verifiedAt'>[]): string | null {
  const stamps = units
    .filter((u) => u.availability === 'AVAILABLE' && u.verifiedAt)
    .map((u) => u.verifiedAt as string);
  if (stamps.length === 0) return null;
  return stamps.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
}

// ── Pipeline board (5 forward-flow columns) ───────────────────────────────────

export interface BoardColumn {
  key: string;
  label: string;
  /** Stages folded into this column. */
  stages: LeadStage[];
}

/**
 * The five-stage buyer pipeline. Intermediate stages fold into the nearest
 * forward column; terminal CLOSED_LOST / DORMANT leads drop off the board.
 */
export const PIPELINE_COLUMNS: BoardColumn[] = [
  { key: 'NEW', label: 'New', stages: ['NEW', 'CONTACTED'] },
  { key: 'QUALIFIED', label: 'Qualified', stages: ['QUALIFIED'] },
  { key: 'VISIT_BOOKED', label: 'Visit Booked', stages: ['VISIT_BOOKED', 'VISITED'] },
  { key: 'NEGOTIATING', label: 'Negotiating', stages: ['NEGOTIATING'] },
  { key: 'CLOSED_WON', label: 'Closed Won', stages: ['CLOSED_WON'] },
];

// ── Lead filtering (client-side pipeline filters + search) ────────────────────

/** Coarse source buckets for the pipeline filter bar. Each maps to one or more
 * raw {@link LeadSource} values; the "ALL" bucket (empty `sources`) matches every
 * lead. Keeps the UI to a handful of intuitive choices over the nine raw sources. */
export type SourceFilterKey = 'ALL' | 'PORTAL' | 'META' | 'DIRECT' | 'CSV' | 'REFERRAL';

export const SOURCE_FILTERS: { key: SourceFilterKey; label: string; sources: LeadSource[] }[] = [
  { key: 'ALL', label: 'All sources', sources: [] },
  { key: 'PORTAL', label: 'Portal', sources: ['PORTAL'] },
  { key: 'META', label: 'Meta', sources: ['META_LEAD_AD'] },
  { key: 'DIRECT', label: 'Direct', sources: ['CTWA', 'WALK_IN', 'MANUAL', 'IVR'] },
  { key: 'CSV', label: 'CSV', sources: ['CSV'] },
  { key: 'REFERRAL', label: 'Referral', sources: ['REFERRAL', 'EXCHANGE_INBOUND'] },
];

export interface LeadFilterState {
  /** Free-text match against name or phone (case-insensitive; phone ignores spaces). */
  search: string;
  temperature: 'ALL' | LeadTemperature;
  sourceKey: SourceFilterKey;
  /** 'ALL', 'UNASSIGNED', or a specific `assignedAgentId`. */
  agentId: 'ALL' | 'UNASSIGNED' | string;
}

export const DEFAULT_LEAD_FILTERS: LeadFilterState = {
  search: '',
  temperature: 'ALL',
  sourceKey: 'ALL',
  agentId: 'ALL',
};

export function leadMatchesFilters(lead: Lead, f: LeadFilterState): boolean {
  if (f.temperature !== 'ALL' && lead.temperature !== f.temperature) return false;

  if (f.agentId === 'UNASSIGNED') {
    if (lead.assignedAgentId != null) return false;
  } else if (f.agentId !== 'ALL' && lead.assignedAgentId !== f.agentId) {
    return false;
  }

  const group = SOURCE_FILTERS.find((s) => s.key === f.sourceKey);
  if (group && group.sources.length > 0 && !group.sources.includes(lead.source)) return false;

  const q = f.search.trim().toLowerCase();
  if (q) {
    const name = (lead.name ?? '').toLowerCase();
    const phones = `${lead.whatsappPhone} ${lead.altPhone ?? ''}`.replace(/\s+/g, '');
    const qDigits = q.replace(/\s+/g, '');
    if (!name.includes(q) && !phones.includes(qDigits)) return false;
  }

  return true;
}

export function filterLeads(leads: Lead[], f: LeadFilterState): Lead[] {
  return leads.filter((l) => leadMatchesFilters(l, f));
}

/** True when any filter is narrowing the set (i.e. not the default state). */
export function hasActiveLeadFilters(f: LeadFilterState): boolean {
  return (
    f.search.trim() !== '' ||
    f.temperature !== 'ALL' ||
    f.sourceKey !== 'ALL' ||
    f.agentId !== 'ALL'
  );
}

// ── North Star KPI — site visits per 100 leads ────────────────────────────────

/** Blueprint North Star: a healthy desk books at least this many site visits per
 * 100 leads. Surfaced prominently on the dashboard. */
export const NORTH_STAR_GOAL = 8;

/** Site visits per 100 leads. Returns 0 when there are no leads (avoids /0). */
export function visitsPer100Leads(totalVisits: number, totalLeads: number): number {
  if (totalLeads <= 0) return 0;
  return (totalVisits / totalLeads) * 100;
}
