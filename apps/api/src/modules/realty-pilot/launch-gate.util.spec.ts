/**
 * Pure launch-gate tests (Phase 8, blueprint §24). Verifies the GO / NO_GO /
 * NOT_READY verdict logic and the itemized no-ship checks.
 */

import { LaunchGateStatus, LaunchCheckStatus, NoShipKind } from '@gosumo/shared';
import type { LaunchMetrics } from '@gosumo/shared';
import { evaluateLaunchGate } from './launch-gate.util';

const AT = '2026-07-03T00:00:00.000Z';

/** Metrics that clear every KPI and have no no-ship incidents. */
const passing: LaunchMetrics = {
  responseP95Seconds: 40,
  engagementRatePct: 55,
  qualificationRatePct: 70,
  visitsPer100Leads: 12,
  showUpRatePct: 65,
  aiAutonomyPct: 80,
  hotAlertActionRatePct: 75,
  noShipIncidents: 0,
  noShipByKind: {},
  totalLeads: 200,
};

describe('launch-gate', () => {
  it('returns GO when every KPI passes and no incidents occurred', () => {
    const report = evaluateLaunchGate(passing, AT);
    expect(report.status).toBe(LaunchGateStatus.GO);
    expect(report.failed).toBe(0);
    expect(report.insufficient).toBe(0);
    expect(report.generatedAt).toBe(AT);
  });

  it('returns NO_GO when a KPI is below threshold', () => {
    const report = evaluateLaunchGate({ ...passing, visitsPer100Leads: 5 }, AT);
    expect(report.status).toBe(LaunchGateStatus.NO_GO);
    const visits = report.kpiChecks.find((c) => c.key === 'visits_per_100');
    expect(visits?.status).toBe(LaunchCheckStatus.FAIL);
  });

  it('returns NO_GO when a no-ship incident occurred (even with KPIs green)', () => {
    const report = evaluateLaunchGate(
      { ...passing, noShipIncidents: 1, noShipByKind: { [NoShipKind.UNVERIFIED_PRICE]: 1 } },
      AT,
    );
    expect(report.status).toBe(LaunchGateStatus.NO_GO);
    const check = report.noShipChecks.find((c) => c.key === 'no_ship_unverified_price');
    expect(check?.status).toBe(LaunchCheckStatus.FAIL);
    expect(check?.actual).toBe(1);
  });

  it('returns NOT_READY when a KPI is unmeasured but nothing failed', () => {
    const report = evaluateLaunchGate({ ...passing, responseP95Seconds: null }, AT);
    expect(report.status).toBe(LaunchGateStatus.NOT_READY);
    const p95 = report.kpiChecks.find((c) => c.key === 'response_p95');
    expect(p95?.status).toBe(LaunchCheckStatus.INSUFFICIENT_DATA);
  });

  it('always itemizes the four canonical no-ship checks (defaulting to PASS)', () => {
    const report = evaluateLaunchGate(passing, AT);
    const keys = report.noShipChecks.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'no_ship_unverified_price',
        'no_ship_stale_availability',
        'no_ship_opted_out_send',
        'no_ship_rera_claim',
      ]),
    );
    expect(report.noShipChecks.every((c) => c.status === LaunchCheckStatus.PASS)).toBe(true);
  });

  it('uses lte for response-P95 (lower is better) and gte for the rest', () => {
    const report = evaluateLaunchGate({ ...passing, responseP95Seconds: 60 }, AT);
    expect(report.kpiChecks.find((c) => c.key === 'response_p95')?.status).toBe(
      LaunchCheckStatus.PASS,
    ); // exactly 60 passes (<= 60)
    const over = evaluateLaunchGate({ ...passing, responseP95Seconds: 61 }, AT);
    expect(over.kpiChecks.find((c) => c.key === 'response_p95')?.status).toBe(
      LaunchCheckStatus.FAIL,
    );
  });
});
