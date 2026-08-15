import { Test } from '@nestjs/testing';
import { ChannelType } from '@gosumo/shared';

import {
  CHANNEL_DEGRADED_AFTER,
  CHANNEL_FAILING_AFTER,
  ChannelHealthService,
  gradeChannel,
} from './channel-health.service';

const AT = new Date('2026-08-15T10:00:00.000Z');

function makeService(now: () => Date = () => AT): ChannelHealthService {
  return new ChannelHealthService(now);
}

/** Drive `count` consecutive inbound failures on one channel. */
function failInbound(
  service: ChannelHealthService,
  channel: ChannelType,
  count: number,
  error: unknown = new Error('boom'),
): void {
  for (let i = 0; i < count; i += 1) {
    service.recordInboundFailure(channel, error);
  }
}

describe('gradeChannel', () => {
  it('grades by the consecutive run, at the documented boundaries', () => {
    expect(gradeChannel(0)).toBe('healthy');
    expect(gradeChannel(CHANNEL_DEGRADED_AFTER - 1)).toBe('healthy');
    expect(gradeChannel(CHANNEL_DEGRADED_AFTER)).toBe('degraded');
    expect(gradeChannel(CHANNEL_FAILING_AFTER - 1)).toBe('degraded');
    expect(gradeChannel(CHANNEL_FAILING_AFTER)).toBe('failing');
  });
});

describe('ChannelHealthService — dependency injection', () => {
  /**
   * The regression that took down the whole graph. `ChannelHealthService` is an
   * `@Injectable()` whose only constructor parameter is a function, and
   * `design:paramtypes` erases that to `Function` — so without an explicit
   * optional token Nest tries to resolve a provider called `Function`, fails,
   * and refuses to instantiate `ChannelAdapterModule` and everything importing
   * it. A default parameter value does not help; the injector never sees it.
   *
   * `app.module.spec.ts` catches this too, but only as "the entire application
   * failed to build", which points at no particular provider.
   */
  it('resolves from the Nest container with no clock provider registered', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ChannelHealthService],
    }).compile();

    const service = moduleRef.get(ChannelHealthService);

    expect(service).toBeInstanceOf(ChannelHealthService);
    // The default clock took effect, rather than `undefined` being injected and
    // blowing up on the first recorded timestamp.
    service.recordInboundSuccess(ChannelType.WHATSAPP);
    expect(service.snapshot(ChannelType.WHATSAPP)?.inbound.lastOkAt).not.toBeNull();
  });
});

describe('ChannelHealthService — recording', () => {
  it('starts every known channel healthy and empty', () => {
    const snapshots = makeService().snapshots();

    expect(snapshots).toHaveLength(Object.values(ChannelType).length);
    for (const snapshot of snapshots) {
      expect(snapshot.state).toBe('healthy');
      expect(snapshot.inbound).toMatchObject({ ok: 0, failed: 0, consecutiveFailures: 0 });
      expect(snapshot.outbound).toMatchObject({ ok: 0, failed: 0, consecutiveFailures: 0 });
    }
  });

  it('counts a success and stamps when it happened', () => {
    const service = makeService();
    service.recordInboundSuccess(ChannelType.WHATSAPP);

    expect(service.snapshot(ChannelType.WHATSAPP)?.inbound).toMatchObject({
      ok: 1,
      failed: 0,
      consecutiveFailures: 0,
      lastOkAt: AT.toISOString(),
      lastFailureAt: null,
    });
  });

  it('keeps the failure message from an Error and from a thrown non-Error alike', () => {
    const service = makeService();
    service.recordInboundFailure(ChannelType.SMS, new Error('signature mismatch'));
    expect(service.snapshot(ChannelType.SMS)?.inbound.lastError).toBe('signature mismatch');

    service.recordOutboundFailure(ChannelType.SMS, 'provider said no');
    expect(service.snapshot(ChannelType.SMS)?.outbound.lastError).toBe('provider said no');
  });

  /**
   * The reason this counts consecutive failures rather than a rate: a channel
   * carrying heavy traffic with a little junk in it is not the one worth waking
   * an operator for, and a ratio cannot tell it apart from one refusing
   * everything.
   */
  it('resets the run on a success but keeps the totals', () => {
    const service = makeService();
    failInbound(service, ChannelType.INSTAGRAM, CHANNEL_DEGRADED_AFTER);
    expect(service.snapshot(ChannelType.INSTAGRAM)?.state).toBe('degraded');

    service.recordInboundSuccess(ChannelType.INSTAGRAM);

    expect(service.snapshot(ChannelType.INSTAGRAM)).toMatchObject({
      state: 'healthy',
      inbound: { ok: 1, failed: CHANNEL_DEGRADED_AFTER, consecutiveFailures: 0 },
    });
  });

  it('grades on the worse of the two directions', () => {
    const service = makeService();
    // Inbound is fine; outbound is not. The channel is still broken.
    service.recordInboundSuccess(ChannelType.EMAIL);
    for (let i = 0; i < CHANNEL_FAILING_AFTER; i += 1) {
      service.recordOutboundFailure(ChannelType.EMAIL, new Error('smtp refused'));
    }

    expect(service.snapshot(ChannelType.EMAIL)?.state).toBe('failing');
  });

  it('tracks each channel independently', () => {
    const service = makeService();
    failInbound(service, ChannelType.INSTAGRAM, CHANNEL_FAILING_AFTER);

    expect(service.snapshot(ChannelType.INSTAGRAM)?.state).toBe('failing');
    expect(service.snapshot(ChannelType.WHATSAPP)?.state).toBe('healthy');
    expect(service.isInboundFailing(ChannelType.INSTAGRAM)).toBe(true);
    expect(service.isInboundFailing(ChannelType.WHATSAPP)).toBe(false);
  });

  /**
   * `/webhooks/:channel` puts a caller-supplied string one validation away from
   * this map. An unknown name must not allocate a record — an unbounded map
   * keyed on a URL segment is a memory leak with a URL.
   */
  it('ignores a channel name that is not a known type', () => {
    const service = makeService();
    const bogus = 'TELEGRAM' as ChannelType;

    expect(() => service.recordInboundFailure(bogus, new Error('x'))).not.toThrow();
    expect(service.snapshot(bogus)).toBeNull();
    expect(service.isInboundFailing(bogus)).toBe(false);
    expect(service.snapshots()).toHaveLength(Object.values(ChannelType).length);
  });

  it('hands out copies, so a caller cannot mutate the tallies', () => {
    const service = makeService();
    service.recordInboundSuccess(ChannelType.WHATSAPP);

    const snapshot = service.snapshot(ChannelType.WHATSAPP);
    snapshot!.inbound.ok = 9_999;

    expect(service.snapshot(ChannelType.WHATSAPP)?.inbound.ok).toBe(1);
  });
});

describe('ChannelHealthService — publicSnapshots', () => {
  it('is empty in normal operation, so its presence is the signal', () => {
    const service = makeService();
    service.recordInboundSuccess(ChannelType.WHATSAPP);

    expect(service.publicSnapshots()).toEqual([]);
  });

  /**
   * The readiness probe is `@Public()`. `lastError` can quote a provider's own
   * error text, a tenant id or a recipient — the 200-body disclosure rule the
   * app's CLAUDE.md sets out.
   */
  it('names the channel but publishes no error text', () => {
    const service = makeService();
    failInbound(
      service,
      ChannelType.INSTAGRAM,
      CHANNEL_DEGRADED_AFTER,
      new Error('app-scoped id 17841400000000000 rejected'),
    );

    const published = service.publicSnapshots();

    expect(published).toEqual([
      {
        channel: ChannelType.INSTAGRAM,
        state: 'degraded',
        inboundConsecutiveFailures: CHANNEL_DEGRADED_AFTER,
        outboundConsecutiveFailures: 0,
      },
    ]);
    expect(JSON.stringify(published)).not.toContain('17841400000000000');
  });
});

describe('ChannelHealthService — logging', () => {
  /**
   * Logged at the two grade boundaries only. Every failure already produced a
   * line where it happened; repeating it here would double an incident's log
   * volume to say what the first line implied.
   */
  it('logs once when a channel crosses into degraded, not once per failure', () => {
    const service = makeService();
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);

    failInbound(service, ChannelType.SMS, CHANNEL_DEGRADED_AFTER + 2);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('escalates to error exactly once at the failing boundary', () => {
    const service = makeService();
    const error = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    failInbound(service, ChannelType.SMS, CHANNEL_FAILING_AFTER + 3);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('Other channels are unaffected');
    error.mockRestore();
  });

  it('announces a recovery only when the channel had actually gone bad', () => {
    const service = makeService();
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

    // Below the degraded threshold: a blip, not an incident.
    failInbound(service, ChannelType.WEB_CHAT, CHANNEL_DEGRADED_AFTER - 1);
    service.recordInboundSuccess(ChannelType.WEB_CHAT);
    expect(log).not.toHaveBeenCalled();

    failInbound(service, ChannelType.WEB_CHAT, CHANNEL_DEGRADED_AFTER);
    service.recordInboundSuccess(ChannelType.WEB_CHAT);
    expect(log).toHaveBeenCalledTimes(1);

    log.mockRestore();
  });
});

describe('ChannelHealthService — reset', () => {
  it('clears one channel without touching the others', () => {
    const service = makeService();
    failInbound(service, ChannelType.INSTAGRAM, CHANNEL_FAILING_AFTER);
    failInbound(service, ChannelType.SMS, CHANNEL_FAILING_AFTER);

    service.reset(ChannelType.INSTAGRAM);

    expect(service.snapshot(ChannelType.INSTAGRAM)?.state).toBe('healthy');
    expect(service.snapshot(ChannelType.SMS)?.state).toBe('failing');
  });

  it('clears every channel when given no argument', () => {
    const service = makeService();
    failInbound(service, ChannelType.INSTAGRAM, CHANNEL_FAILING_AFTER);
    failInbound(service, ChannelType.SMS, CHANNEL_FAILING_AFTER);

    service.reset();

    expect(service.snapshots().every((s) => s.state === 'healthy')).toBe(true);
  });
});
