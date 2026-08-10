/**
 * Parser-health unit tests. The pure evaluator (evaluateSample / buildPortalReport)
 * is tested against known-good and drifted inputs; ParserHealthService is tested
 * with a mocked repository + EventEmitter2 (no DB).
 *
 * Coverage: healthy parse, empty (null) parse, per-field drift, status rollup
 * (HEALTHY/DEGRADED/FAILED), and the persist + degraded-event emission path.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { RealtyParserHealthStatus } from '@prisma/client';
import { RealtyPortal } from '@gosumo/shared';

import {
  evaluateSample,
  buildPortalReport,
  ParserHealthService,
} from './parser-health.service';
import { PARSER_SAMPLES } from './parser-health.samples';
import type { ParserSample } from './parser-health.samples';
import { ParserHealthRepository } from './parser-health.repository';

const NINETYNINE = PARSER_SAMPLES.find(
  (s) => s.portal === RealtyPortal.NINETYNINE_ACRES,
) as ParserSample;

describe('evaluateSample', () => {
  it('passes a known-good 99acres sample with all expected fields', () => {
    const res = evaluateSample(NINETYNINE);
    expect(res.passed).toBe(true);
    expect(res.empty).toBe(false);
    expect(res.missingFields).toHaveLength(0);
    expect(res.portalMismatch).toBe(false);
  });

  it('flags an empty parse (no recoverable phone → null candidate)', () => {
    const drifted: ParserSample = {
      ...NINETYNINE,
      input: { from: 'response@99acres.com', subject: 'x', text: 'no contact here' },
    };
    const res = evaluateSample(drifted);
    expect(res.empty).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.missingFields).toEqual(expect.arrayContaining(['phone']));
  });

  it('detects field drift when the name label changes but phone survives', () => {
    const drifted: ParserSample = {
      ...NINETYNINE,
      input: {
        from: 'response@99acres.com',
        subject: 'New Response',
        // No "Name:" label — the parser can no longer recover the buyer name.
        text: 'Phone: +91 98765 43210\nEmail: rahul@example.com',
      },
    };
    const res = evaluateSample(drifted);
    expect(res.passed).toBe(false);
    expect(res.missingFields).toContain('name');
    expect(res.missingFields).not.toContain('phone');
  });
});

describe('buildPortalReport', () => {
  it('is HEALTHY when every sample passes', () => {
    const report = buildPortalReport('99ACRES', [NINETYNINE]);
    expect(report.status).toBe(RealtyParserHealthStatus.HEALTHY);
    expect(report.passCount).toBe(1);
    expect(report.failCount).toBe(0);
  });

  it('is FAILED when every sample is empty/failed', () => {
    const broken: ParserSample = {
      ...NINETYNINE,
      input: { from: 'response@99acres.com', subject: 'x', text: 'nothing' },
    };
    const report = buildPortalReport('99ACRES', [broken]);
    expect(report.status).toBe(RealtyParserHealthStatus.FAILED);
    expect(report.emptyCount).toBe(1);
  });

  it('is DEGRADED when some pass and some fail', () => {
    const broken: ParserSample = {
      ...NINETYNINE,
      label: 'drifted',
      input: { from: 'response@99acres.com', subject: 'x', text: 'nothing' },
    };
    const report = buildPortalReport('99ACRES', [NINETYNINE, broken]);
    expect(report.status).toBe(RealtyParserHealthStatus.DEGRADED);
    expect(report.passCount).toBe(1);
    expect(report.failCount).toBe(1);
  });
});

describe('ParserHealthService', () => {
  let service: ParserHealthService;
  let repo: jest.Mocked<ParserHealthRepository>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(() => {
    repo = {
      record: jest.fn().mockResolvedValue(undefined),
      latest: jest.fn(),
      latestAll: jest.fn(),
    } as unknown as jest.Mocked<ParserHealthRepository>;
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    service = new ParserHealthService(repo, emitter);
  });

  it('runs the bundled fixtures, persists a snapshot per portal, all HEALTHY', async () => {
    const reports = await service.runCheck();
    expect(reports).toHaveLength(3); // 99acres, MagicBricks, Housing
    expect(reports.every((r) => r.status === RealtyParserHealthStatus.HEALTHY)).toBe(true);
    expect(repo.record).toHaveBeenCalledTimes(3);
    // Healthy portals emit health_checked but NOT degraded.
    expect(emitter.emit).toHaveBeenCalledWith(
      'realty.parser.health_checked',
      expect.objectContaining({ status: RealtyParserHealthStatus.HEALTHY }),
    );
    expect(emitter.emit).not.toHaveBeenCalledWith(
      'realty.parser.degraded',
      expect.anything(),
    );
  });

  it('emits realty.parser.degraded when a portal drifts', async () => {
    const drifted: ParserSample = {
      ...NINETYNINE,
      input: { from: 'response@99acres.com', subject: 'x', text: 'nothing here' },
    };
    await service.runCheck([drifted]);
    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: RealtyParserHealthStatus.FAILED }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      'realty.parser.degraded',
      expect.objectContaining({
        portal: RealtyPortal.NINETYNINE_ACRES,
        missingFields: expect.arrayContaining(['phone']),
      }),
    );
  });
});
