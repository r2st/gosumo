import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RealtyParserHealthStatus } from '@prisma/client';
import { generateId, generateCorrelationId, RealtyPortal } from '@gosumo/shared';
import { parsePortalEmail } from '../portal-email.parser';
import { PARSER_SAMPLES } from './parser-health.samples';
import type { ParserSample, ExpectedField } from './parser-health.samples';
import { ParserHealthRepository } from './parser-health.repository';
import type {
  RealtyParserHealthCheckedEvent,
  RealtyParserDegradedEvent,
} from './parser-health.events';

/** Outcome of parsing one sample email. */
export interface SampleResult {
  label: string;
  /** True when the parser returned a candidate that has every expected field. */
  passed: boolean;
  /** True when the parser returned null (no candidate at all). */
  empty: boolean;
  /** Expected fields the parser failed to recover (the drift signature). */
  missingFields: ExpectedField[];
  /** True when the portal was mis-detected (drift in sender/subject matching). */
  portalMismatch: boolean;
}

export interface PortalHealthReport {
  portal: string;
  status: RealtyParserHealthStatus;
  sampleCount: number;
  passCount: number;
  failCount: number;
  emptyCount: number;
  /** Union of every missing field across this portal's samples. */
  missingFields: ExpectedField[];
  samples: SampleResult[];
}

/** Extract just the digits, drop a leading country/trunk prefix for comparison. */
function significantDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length > 10 && digits.startsWith('0')) return digits.slice(-10);
  return digits;
}

/**
 * Evaluate one sample against the parser (pure — no I/O). A sample passes only
 * when the parser returns a candidate whose portal matches and that carries
 * every expected field (with the phone containing the expected digits).
 */
export function evaluateSample(sample: ParserSample): SampleResult {
  const candidate = parsePortalEmail(sample.input);
  if (!candidate) {
    return {
      label: sample.label,
      passed: false,
      empty: true,
      missingFields: [...sample.expect],
      portalMismatch: false,
    };
  }

  const missing: ExpectedField[] = [];
  for (const field of sample.expect) {
    if (field === 'phone') {
      const digits = candidate.phone ? significantDigits(candidate.phone) : '';
      if (!digits.includes(sample.expectPhoneDigits)) missing.push('phone');
    } else if (field === 'name' && !candidate.name) {
      missing.push('name');
    } else if (field === 'email' && !candidate.email) {
      missing.push('email');
    } else if (field === 'listingRef' && !candidate.listingRef) {
      missing.push('listingRef');
    }
  }

  return {
    label: sample.label,
    passed: missing.length === 0 && candidate.portal === sample.portal,
    empty: false,
    missingFields: missing,
    portalMismatch: candidate.portal !== sample.portal,
  };
}

/**
 * Roll a portal's sample results into a health report. HEALTHY when all pass;
 * FAILED when every sample is empty/failed; DEGRADED in between.
 */
export function buildPortalReport(
  portal: string,
  samples: ParserSample[],
): PortalHealthReport {
  const results = samples.map(evaluateSample);
  const passCount = results.filter((r) => r.passed).length;
  const emptyCount = results.filter((r) => r.empty).length;
  const failCount = results.length - passCount;
  const missingFields = Array.from(
    new Set(results.flatMap((r) => r.missingFields)),
  );

  let status: RealtyParserHealthStatus;
  if (passCount === results.length) status = RealtyParserHealthStatus.HEALTHY;
  else if (passCount === 0) status = RealtyParserHealthStatus.FAILED;
  else status = RealtyParserHealthStatus.DEGRADED;

  return {
    portal,
    status,
    sampleCount: results.length,
    passCount,
    failCount,
    emptyCount,
    missingFields,
    samples: results,
  };
}

/**
 * ParserHealthService — monitors the property-portal email parsers for format
 * drift (blueprint §15 resilience). Weekly (BullMQ) and on-demand it re-parses
 * known-good sample emails; when a portal (99acres / MagicBricks / Housing.com)
 * changes its template the parser starts dropping fields, which this catches and
 * surfaces via `realty.parser.degraded` before real leads are silently lost.
 */
@Injectable()
export class ParserHealthService {
  private readonly logger = new Logger(ParserHealthService.name);

  constructor(
    private readonly repository: ParserHealthRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Run the health check across every portal and persist + emit the results.
   * `samples` defaults to the bundled known-good fixtures; it is a parameter so
   * tests can drive drift scenarios.
   */
  async runCheck(samples: ParserSample[] = PARSER_SAMPLES): Promise<PortalHealthReport[]> {
    const byPortal = new Map<RealtyPortal, ParserSample[]>();
    for (const sample of samples) {
      const list: ParserSample[] = byPortal.get(sample.portal) ?? [];
      list.push(sample);
      byPortal.set(sample.portal, list);
    }

    const reports: PortalHealthReport[] = [];
    for (const [portal, samples] of byPortal) {
      const report = buildPortalReport(portal, samples);
      reports.push(report);
      await this.persistAndEmit(report);
    }
    const degraded = reports.filter(
      (r) => r.status !== RealtyParserHealthStatus.HEALTHY,
    );
    this.logger.log(
      `Parser health check: ${reports.length} portal(s), ${degraded.length} degraded/failed`,
    );
    return reports;
  }

  async getLatestReports() {
    return this.repository.latestAll();
  }

  private async persistAndEmit(report: PortalHealthReport): Promise<void> {
    await this.repository.record({
      portal: report.portal,
      status: report.status,
      sampleCount: report.sampleCount,
      passCount: report.passCount,
      failCount: report.failCount,
      emptyCount: report.emptyCount,
      details: {
        missingFields: report.missingFields,
        samples: report.samples,
      },
    });

    const base = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      correlationId: generateCorrelationId(),
    };

    this.eventEmitter.emit('realty.parser.health_checked', {
      ...base,
      type: 'realty.parser.health_checked',
      portal: report.portal,
      status: report.status,
      sampleCount: report.sampleCount,
      passCount: report.passCount,
      failCount: report.failCount,
    } as RealtyParserHealthCheckedEvent);

    if (report.status !== RealtyParserHealthStatus.HEALTHY) {
      this.eventEmitter.emit('realty.parser.degraded', {
        ...base,
        type: 'realty.parser.degraded',
        portal: report.portal,
        status: report.status,
        failCount: report.failCount,
        emptyCount: report.emptyCount,
        missingFields: report.missingFields,
      } as RealtyParserDegradedEvent);
      this.logger.warn(
        `Portal parser DEGRADED: ${report.portal} — ${report.failCount}/${report.sampleCount} failed, missing [${report.missingFields.join(', ')}]`,
      );
    }
  }
}
