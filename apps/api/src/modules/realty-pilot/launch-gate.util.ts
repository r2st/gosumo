/**
 * The launch-readiness gate (Phase 8, blueprint §24).
 *
 * A pure evaluation of the pilot KPIs against their launch thresholds, plus the
 * hard "no-ship" checks. The verdict is:
 *   • NO_GO — any KPI hard-fails OR any no-ship incident occurred.
 *   • NOT_READY — no hard fail, but a KPI could not be measured (null).
 *   • GO — every KPI passed and no no-ship incident occurred.
 *
 * The no-ship checks (blueprint §24) each assert a specific violation kind never
 * shipped: a price absent from a verified sheet, availability affirmed for
 * SOLD/HOLD/UNVERIFIED, a send to an opted-out number, or a RERA claim beyond
 * sheet-verbatim (plus cross-buyer disclosure). Guardrails keep these at zero.
 */

import { LaunchGateStatus, LaunchCheckStatus, NoShipKind } from '@gosumo/shared';
import type {
  LaunchMetrics,
  LaunchGateCheck,
  LaunchGateReport,
} from '@gosumo/shared';

interface KpiSpec {
  key: string;
  label: string;
  threshold: number;
  comparator: 'gte' | 'lte';
  value: (m: LaunchMetrics) => number | null;
}

/** The §24 KPI gates in report order. */
export const LAUNCH_KPI_SPECS: KpiSpec[] = [
  { key: 'response_p95', label: 'Response P95 < 60s', threshold: 60, comparator: 'lte', value: (m) => m.responseP95Seconds },
  { key: 'engagement', label: 'Engagement ≥ 40%', threshold: 40, comparator: 'gte', value: (m) => m.engagementRatePct },
  { key: 'qualification', label: 'Qualification ≥ 60%', threshold: 60, comparator: 'gte', value: (m) => m.qualificationRatePct },
  { key: 'visits_per_100', label: 'Site visits / 100 leads ≥ 8', threshold: 8, comparator: 'gte', value: (m) => m.visitsPer100Leads },
  { key: 'show_up', label: 'Show-up ≥ 60%', threshold: 60, comparator: 'gte', value: (m) => m.showUpRatePct },
  { key: 'ai_autonomy', label: 'AI autonomy ≥ 70%', threshold: 70, comparator: 'gte', value: (m) => m.aiAutonomyPct },
  { key: 'hot_alert_action', label: 'Hot-alert action < 30 min ≥ 70%', threshold: 70, comparator: 'gte', value: (m) => m.hotAlertActionRatePct },
];

/** The no-ship kinds the §24 gate itemizes (always reported, defaulting to 0). */
const NO_SHIP_LABELS: Record<string, string> = {
  [NoShipKind.UNVERIFIED_PRICE]: 'No unverified price stated',
  [NoShipKind.STALE_AVAILABILITY]: 'No availability affirmed for SOLD/HOLD/UNVERIFIED',
  [NoShipKind.OPTED_OUT_SEND]: 'No send to an opted-out number',
  [NoShipKind.RERA_CLAIM]: 'No RERA claim beyond sheet-verbatim',
  [NoShipKind.CROSS_BUYER]: "No cross-buyer disclosure",
};

function compare(actual: number, threshold: number, comparator: 'gte' | 'lte' | 'eq'): boolean {
  if (comparator === 'gte') return actual >= threshold;
  if (comparator === 'lte') return actual <= threshold;
  return actual === threshold;
}

function evaluateKpi(spec: KpiSpec, metrics: LaunchMetrics): LaunchGateCheck {
  const actual = spec.value(metrics);
  if (actual === null) {
    return {
      key: spec.key,
      label: spec.label,
      status: LaunchCheckStatus.INSUFFICIENT_DATA,
      actual: null,
      threshold: spec.threshold,
      comparator: spec.comparator,
      detail: 'Metric could not be measured for this window',
    };
  }
  const pass = compare(actual, spec.threshold, spec.comparator);
  return {
    key: spec.key,
    label: spec.label,
    status: pass ? LaunchCheckStatus.PASS : LaunchCheckStatus.FAIL,
    actual,
    threshold: spec.threshold,
    comparator: spec.comparator,
    detail: pass ? 'Meets the launch threshold' : 'Below the launch threshold',
  };
}

function evaluateNoShip(kind: string, count: number): LaunchGateCheck {
  return {
    key: `no_ship_${kind.toLowerCase()}`,
    label: NO_SHIP_LABELS[kind] ?? `No ${kind} incidents`,
    status: count === 0 ? LaunchCheckStatus.PASS : LaunchCheckStatus.FAIL,
    actual: count,
    threshold: 0,
    comparator: 'eq',
    detail: count === 0 ? 'No incidents recorded' : `${count} incident(s) recorded`,
  };
}

/**
 * Evaluate the full launch-readiness gate. `generatedAt` is injected (the util
 * is pure — no clock access) so callers stamp the report deterministically.
 */
export function evaluateLaunchGate(
  metrics: LaunchMetrics,
  generatedAt: string,
  windowDays: number | null = null,
): LaunchGateReport {
  const kpiChecks = LAUNCH_KPI_SPECS.map((spec) => evaluateKpi(spec, metrics));

  const byKind = metrics.noShipByKind ?? {};
  // Always itemize the canonical no-ship kinds, then any others actually seen.
  const kinds = new Set<string>([...Object.keys(NO_SHIP_LABELS), ...Object.keys(byKind)]);
  const noShipChecks = [...kinds].map((kind) => evaluateNoShip(kind, byKind[kind] ?? 0));

  const all = [...kpiChecks, ...noShipChecks];
  const failed = all.filter((c) => c.status === LaunchCheckStatus.FAIL).length;
  const insufficient = all.filter((c) => c.status === LaunchCheckStatus.INSUFFICIENT_DATA).length;
  const passed = all.filter((c) => c.status === LaunchCheckStatus.PASS).length;

  let status: string;
  if (failed > 0) status = LaunchGateStatus.NO_GO;
  else if (insufficient > 0) status = LaunchGateStatus.NOT_READY;
  else status = LaunchGateStatus.GO;

  return {
    status,
    kpiChecks,
    noShipChecks,
    passed,
    failed,
    insufficient,
    windowDays,
    generatedAt,
  };
}
