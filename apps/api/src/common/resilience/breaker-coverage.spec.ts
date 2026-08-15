/**
 * Contract: the breakers are actually wired to the calls they are named after.
 *
 * `circuit-breaker.spec.ts` proves the mechanism. This file proves the
 * *plumbing*, which is the half that rots: a breaker resolved into a field and
 * then never called still passes every unit test of the breaker itself, and
 * still shows up in the health probe as permanently closed — a green light
 * meaning "nothing has ever gone through me", indistinguishable from
 * "everything is healthy".
 *
 * So each case here drives a real service against a mocked `fetch` until its
 * breaker opens, then asserts the next call **never reaches `fetch` at all**.
 * That last assertion is the whole product: a stalled provider costs a
 * `fetchWithTimeout` deadline per call, and not making the call is the only
 * thing that stops one dead dependency from consuming every worker slot and
 * every Postgres connection the process has.
 */

import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';
import {
  RAZORPAY_BREAKER,
  INSTAGRAM_BREAKER,
  SENDGRID_BREAKER,
  STRIPE_BREAKER,
  TWILIO_BREAKER,
  WHATSAPP_BREAKER,
} from './circuit-breaker.constants';
import { RazorpayService } from '../../modules/payment/razorpay.service';
import { StripeService } from '../../modules/payment/stripe.service';
import { WhatsAppAdapter } from '../../modules/channel-adapter/adapters/whatsapp.adapter';
import { SmsAdapter } from '../../modules/channel-adapter/adapters/sms.adapter';
import { EmailAdapter } from '../../modules/channel-adapter/adapters/email.adapter';
import { InstagramAdapter } from '../../modules/channel-adapter/adapters/instagram.adapter';
import { MessageContentType, type OutboundMessage } from '@gosumo/shared';

/** Config that answers every key with a plausible credential. */
function config(values: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    RAZORPAY_KEY_ID: 'rzp_test',
    RAZORPAY_KEY_SECRET: 'secret',
    STRIPE_SECRET_KEY: 'sk_test',
    'whatsapp.accessToken': 'token',
    'whatsapp.phoneNumberId': '123',
    'whatsapp.appSecret': 'app-secret',
    'twilio.accountSid': 'AC123',
    'twilio.authToken': 'token',
    'twilio.fromNumber': '+15550000000',
    'instagram.accessToken': 'token',
    'instagram.pageId': '456',
    'instagram.appSecret': 'app-secret',
    'sendgrid.apiKey': 'SG.key',
    'sendgrid.fromEmail': 'noreply@example.com',
  };
  return {
    get: jest.fn(
      (key: string, fallback?: unknown) => values[key] ?? defaults[key] ?? fallback ?? '',
    ),
  } as unknown as ConfigService;
}

/** A 503 — the provider being unavailable to everyone. */
const unavailable = () =>
  ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => 'upstream down',
    json: async () => ({ error: { message: 'down', code: 1 } }),
  }) as unknown as Response;

function outboundText(): OutboundMessage {
  return {
    channelAccountId: 'acct-1',
    recipientExternalId: '+919876543210',
    content: { type: MessageContentType.TEXT, text: 'hello' },
  } as unknown as OutboundMessage;
}

describe('circuit breaker coverage', () => {
  let fetchSpy: jest.SpyInstance;
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(unavailable());
    // The adapters back off between attempts; the breaker is what this file is
    // about, so the sleeps are collapsed rather than waited out.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Calls `attempt` until the named breaker opens, then returns the fetch count. */
  async function tripAndFreeze(
    breakerName: string,
    attempt: () => Promise<unknown>,
    maxCalls = 40,
  ): Promise<number> {
    for (let i = 0; i < maxCalls; i++) {
      await attempt().catch(() => undefined);
      if (registry.openCircuits().some((c) => c.name === breakerName)) break;
    }
    expect(registry.openCircuits().map((c) => c.name)).toContain(breakerName);

    const callsWhenOpen = fetchSpy.mock.calls.length;
    await attempt().catch(() => undefined);
    await attempt().catch(() => undefined);
    return fetchSpy.mock.calls.length - callsWhenOpen;
  }

  describe('payment gateways', () => {
    it('stops calling Razorpay once its breaker opens', async () => {
      const service = new RazorpayService(config(), registry);

      const callsWhileOpen = await tripAndFreeze(RAZORPAY_BREAKER.name, () =>
        service.createPaymentLink({ amountPaise: 10_000, currency: 'INR' }),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('stops calling Stripe once its breaker opens', async () => {
      const service = new StripeService(config(), registry);

      const callsWhileOpen = await tripAndFreeze(STRIPE_BREAKER.name, () =>
        service.createCheckoutSession({ amountMinor: 5_000, currency: 'usd' }),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('keeps the two gateways independent', async () => {
      // Razorpay being down must not stop international payments, and vice
      // versa — collapsing them would turn one gateway's incident into a total
      // payments outage.
      const razorpay = new RazorpayService(config(), registry);
      await tripAndFreeze(RAZORPAY_BREAKER.name, () =>
        razorpay.createPaymentLink({ amountPaise: 10_000, currency: 'INR' }),
      );

      expect(registry.openCircuits().map((c) => c.name)).not.toContain(STRIPE_BREAKER.name);
    });
  });

  describe('channel adapters', () => {
    it('stops calling the WhatsApp Cloud API once its breaker opens', async () => {
      const adapter = new WhatsAppAdapter(config(), registry);

      const callsWhileOpen = await tripAndFreeze(WHATSAPP_BREAKER.name, () =>
        adapter.sendMessage(outboundText()),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('stops calling the Instagram Messaging API once its breaker opens', async () => {
      const adapter = new InstagramAdapter(config(), registry);

      const callsWhileOpen = await tripAndFreeze(INSTAGRAM_BREAKER.name, () =>
        adapter.sendMessage({ ...outboundText(), recipientExternalId: 'ig-user-1' }),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('keeps the two Meta products independent', async () => {
      // WhatsApp Cloud API and the Instagram Messaging API are different graph
      // endpoints. Sharing one breaker would let an Instagram incident stop
      // WhatsApp replies for every tenant.
      const adapter = new WhatsAppAdapter(config(), registry);
      await tripAndFreeze(WHATSAPP_BREAKER.name, () => adapter.sendMessage(outboundText()));

      expect(registry.openCircuits().map((c) => c.name)).not.toContain(INSTAGRAM_BREAKER.name);
    });

    it('stops calling Twilio once its breaker opens', async () => {
      const adapter = new SmsAdapter(config(), registry);

      const callsWhileOpen = await tripAndFreeze(TWILIO_BREAKER.name, () =>
        adapter.sendMessage(outboundText()),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('stops calling SendGrid once its breaker opens', async () => {
      const adapter = new EmailAdapter(config(), registry);

      const callsWhileOpen = await tripAndFreeze(SENDGRID_BREAKER.name, () =>
        adapter.sendMessage({
          ...outboundText(),
          recipientExternalId: 'buyer@example.com',
        }),
      );

      expect(callsWhileOpen).toBe(0);
    });

    it('reports a short-circuited send as a failed result, not a throw', async () => {
      // The send path's contract is a SendResult; a throw here would escape
      // into whatever called sendMessage and bypass `message.failed`.
      const adapter = new WhatsAppAdapter(config(), registry);
      await tripAndFreeze(WHATSAPP_BREAKER.name, () => adapter.sendMessage(outboundText()));

      const result = await adapter.sendMessage(outboundText());

      expect(result.success).toBe(false);
      expect(result.error).toContain('circuit is open');
    });

    it('abandons the remaining retry budget instead of sleeping through it', async () => {
      // Retrying in-process against a breaker that will not admit a call for
      // another 30s is pure latency on a send BullMQ will retry anyway.
      const adapter = new WhatsAppAdapter(config(), registry);
      await tripAndFreeze(WHATSAPP_BREAKER.name, () => adapter.sendMessage(outboundText()));

      const result = await adapter.sendMessage(outboundText());

      expect(result.attempts).toBe(1);
    });
  });

  it('leaves an unguarded service unguarded, which is what a unit test wants', async () => {
    // No registry — the adapter must still work, or every existing adapter
    // spec would be constructing something that fast-fails halfway through.
    const adapter = new WhatsAppAdapter(config());

    for (let i = 0; i < 10; i++) {
      await adapter.sendMessage(outboundText()).catch(() => undefined);
    }

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(10);
  });

  it('names every guarded dependency in the health probe once it has been used', async () => {
    // The registry is what `GET /v1/health/ready` reads. A breaker that is
    // never resolved is invisible there, so this pins that using a service
    // registers its breaker.
    new RazorpayService(config(), registry);
    new StripeService(config(), registry);
    new WhatsAppAdapter(config(), registry);
    new InstagramAdapter(config(), registry);
    new SmsAdapter(config(), registry);
    new EmailAdapter(config(), registry);

    expect(registry.snapshots().map((s) => s.name).sort()).toEqual(
      ['Instagram', 'Razorpay', 'SendGrid', 'Stripe', 'Twilio', 'WhatsApp'].sort(),
    );
    // …and every one of them closed until something actually fails.
    expect(registry.openCircuits()).toEqual([]);
  });
});
