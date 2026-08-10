/**
 * CRM adapter unit tests — Sell.Do, LeadSquared, Privyr. Verifies pure payload
 * mapping (BLTC → each CRM's schema) and the push path over a mocked global
 * `fetch` (success, non-2xx, missing-credential, and thrown-error handling).
 */

import { SellDoAdapter } from './selldo.adapter';
import { LeadSquaredAdapter } from './leadsquared.adapter';
import { PrivyrAdapter } from './privyr.adapter';
import type { CrmLead } from './crm-adapter.interface';

function makeLead(overrides: Partial<CrmLead> = {}): CrmLead {
  return {
    leadId: 'lead-1',
    name: 'Rahul Sharma',
    phone: '+919876543210',
    altPhone: null,
    email: 'rahul@example.com',
    source: 'PORTAL',
    subSource: '99acres',
    listingRef: 'Wakad 2BHK',
    budgetMinPaise: 5000000_00,
    budgetMaxPaise: 7500000_00,
    localities: ['Wakad', 'Baner'],
    config: '2BHK',
    timelineMonths: 3,
    purpose: 'END_USE',
    financing: 'LOAN',
    stage: 'QUALIFIED',
    temperature: 'HOT',
    qualScore: 82,
    ...overrides,
  };
}

function mockFetch(response: {
  ok: boolean;
  status: number;
  body?: unknown;
}): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SellDoAdapter', () => {
  const adapter = new SellDoAdapter();

  it('maps BLTC into Sell.Do lead fields (budget in rupees)', () => {
    const payload = adapter.buildPayload(makeLead(), 'created') as {
      lead: Record<string, unknown>;
    };
    expect(payload.lead.phone).toBe('+919876543210');
    expect(payload.lead.budget_min).toBe(5000000);
    expect(payload.lead.budget_max).toBe(7500000);
    expect(payload.lead.preferred_locations).toBe('Wakad, Baner');
    expect(payload.lead.requirement_type).toBe('2BHK');
    expect(payload.lead.external_id).toBe('lead-1');
  });

  it('pushes and returns the CRM external id on success', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { id: 'sd-99' } });
    const res = await adapter.push({ apiKey: 'k' }, makeLead(), 'created');
    expect(res).toEqual({ ok: true, externalId: 'sd-99' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.sell.do/api/leads/create',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails cleanly when the apiKey is missing (no network call)', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const res = await adapter.push({}, makeLead(), 'created');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a non-2xx response as a failure', async () => {
    mockFetch({ ok: false, status: 500, body: {} });
    const res = await adapter.push({ apiKey: 'k' }, makeLead(), 'created');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('500');
  });

  it('verify() checks the apiKey presence', async () => {
    expect(await adapter.verify({ apiKey: 'k' })).toEqual({ ok: true });
    expect((await adapter.verify({})).ok).toBe(false);
  });
});

describe('LeadSquaredAdapter', () => {
  const adapter = new LeadSquaredAdapter();

  it('maps to Attribute/Value pairs incl. India-DC host and split name', () => {
    const payload = adapter.buildPayload(makeLead(), 'stage_changed') as {
      attributes: Array<{ Attribute: string; Value: string }>;
    };
    const byAttr = Object.fromEntries(payload.attributes.map((a) => [a.Attribute, a.Value]));
    expect(byAttr.FirstName).toBe('Rahul');
    expect(byAttr.LastName).toBe('Sharma');
    expect(byAttr.Phone).toBe('+919876543210');
    expect(byAttr.mx_Budget_Min).toBe('5000000');
    expect(byAttr.mx_GoSumo_Lead_Id).toBe('lead-1');
  });

  it('posts the bare attribute array to the Lead.Capture endpoint', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { Status: 'Success', Message: { Id: 'ls-1' } } });
    const res = await adapter.push(
      { accessKey: 'a', secretKey: 's' },
      makeLead(),
      'created',
    );
    expect(res).toEqual({ ok: true, externalId: 'ls-1' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('api-in21.leadsquared.com');
    expect(url).toContain('accessKey=a');
  });

  it('fails when access/secret keys are missing', async () => {
    const res = await adapter.push({ accessKey: 'a' }, makeLead(), 'created');
    expect(res.ok).toBe(false);
  });
});

describe('PrivyrAdapter', () => {
  const adapter = new PrivyrAdapter();

  it('builds a flat contact body with a BLTC remarks block', () => {
    const payload = adapter.buildPayload(makeLead(), 'manual') as Record<string, unknown>;
    expect(payload.phone_number).toBe('+919876543210');
    expect(payload.name).toBe('Rahul Sharma');
    expect(String(payload.remarks)).toContain('Stage: QUALIFIED');
    expect(String(payload.remarks)).toContain('Config: 2BHK');
  });

  it('posts to the configured webhook URL', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const res = await adapter.push(
      { webhookUrl: 'https://hooks.privyr.com/abc' },
      makeLead(),
      'created',
    );
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.privyr.com/abc',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('verify() rejects a non-https webhook URL', async () => {
    expect((await adapter.verify({ webhookUrl: 'http://x' })).ok).toBe(false);
    expect((await adapter.verify({ webhookUrl: 'https://hooks.privyr.com/abc' })).ok).toBe(true);
    expect((await adapter.verify({})).ok).toBe(false);
  });
});

/**
 * The cases above drive each adapter with a fully-populated lead. Most real
 * leads are not: a portal lead arrives with a phone and nothing else, and BLTC
 * fields fill in over the course of a conversation. Every optional field in
 * `CrmLead` is therefore a branch in `buildPayload`, and the failure mode is
 * quiet — a payload carrying the literal string "undefined" or "null" in a
 * broker-visible field, or `₹undefined–₹undefined` in a Privyr remark.
 */
const SPARSE: Partial<CrmLead> = {
  name: null,
  altPhone: null,
  email: null,
  subSource: null,
  listingRef: null,
  budgetMinPaise: null,
  budgetMaxPaise: null,
  localities: [],
  config: null,
  timelineMonths: null,
  purpose: null,
  financing: null,
};

describe('CRM adapters given a bare lead', () => {
  it('SellDo omits unset fields rather than sending null', () => {
    const payload = new SellDoAdapter().buildPayload(makeLead(SPARSE), 'created') as {
      lead: Record<string, unknown>;
    };

    expect(payload.lead.name).toBe('GoSumo Lead');
    for (const key of [
      'alternate_phone',
      'email',
      'campaign',
      'requirement_type',
      'preferred_locations',
      'budget_min',
      'budget_max',
      'possession_in_months',
      'purpose',
      'funding',
    ]) {
      expect(payload.lead[key]).toBeUndefined();
    }
    // The note is broker-visible, so the no-listing case needs real words.
    expect(payload.lead.note).toContain('no listing');
  });

  it('LeadSquared drops unset attributes entirely', () => {
    // LeadSquared stores whatever string it is sent. An `add()` that let
    // `undefined` through would write the text "undefined" into the broker's
    // CRM, where it is indistinguishable from data.
    const payload = new LeadSquaredAdapter().buildPayload(makeLead(SPARSE), 'created') as {
      attributes: Array<{ Attribute: string; Value: string }>;
    };
    const present = payload.attributes.map((a) => a.Attribute);

    // `LastName` is present here — the placeholder name "GoSumo Lead" splits
    // into two parts. The single-word and placeholder cases are pinned
    // separately below.
    expect(present).not.toContain('Mobile');
    expect(present).not.toContain('EmailAddress');
    expect(present).not.toContain('mx_Budget_Min');
    expect(present).not.toContain('mx_Preferred_Locality');
    for (const attr of payload.attributes) {
      expect(attr.Value).not.toMatch(/^(undefined|null)$/);
    }
  });

  it('LeadSquared keeps a single-word name as a first name with no last name', () => {
    const payload = new LeadSquaredAdapter().buildPayload(
      makeLead({ name: 'Rahul' }),
      'created',
    ) as { attributes: Array<{ Attribute: string; Value: string }> };
    const byAttr = Object.fromEntries(payload.attributes.map((a) => [a.Attribute, a.Value]));

    expect(byAttr.FirstName).toBe('Rahul');
    expect(byAttr.LastName).toBeUndefined();
  });

  it('LeadSquared falls back to a placeholder name', () => {
    const payload = new LeadSquaredAdapter().buildPayload(makeLead({ name: null }), 'created') as {
      attributes: Array<{ Attribute: string; Value: string }>;
    };
    const byAttr = Object.fromEntries(payload.attributes.map((a) => [a.Attribute, a.Value]));

    expect(byAttr.FirstName).toBe('GoSumo');
    expect(byAttr.LastName).toBe('Lead');
  });

  it('LeadSquared sends a zero score rather than dropping it', () => {
    // `add()` guards on '' / null / undefined, not falsiness — a brand-new
    // lead scores 0, and dropping the attribute would leave the CRM showing
    // the previous score.
    const payload = new LeadSquaredAdapter().buildPayload(
      makeLead({ qualScore: 0 }),
      'created',
    ) as { attributes: Array<{ Attribute: string; Value: string }> };
    const byAttr = Object.fromEntries(payload.attributes.map((a) => [a.Attribute, a.Value]));

    expect(byAttr.Score).toBe('0');
  });

  it('Privyr says "Not set" instead of rendering an empty budget range', () => {
    const remarks = String(
      (new PrivyrAdapter().buildPayload(makeLead(SPARSE), 'manual') as Record<string, unknown>)
        .remarks,
    );

    expect(remarks).toContain('Budget: Not set');
    expect(remarks).not.toContain('undefined');
    // Optional lines are omitted, not left as empty labels.
    expect(remarks).not.toContain('Config:');
    expect(remarks).not.toContain('Localities:');
    expect(remarks).not.toContain('Timeline:');
    expect(remarks).not.toContain('Listing:');
  });

  it('Privyr renders a half-open budget range with a placeholder for the open end', () => {
    const remarks = String(
      (
        new PrivyrAdapter().buildPayload(
          makeLead({ budgetMinPaise: 5000000_00, budgetMaxPaise: null }),
          'manual',
        ) as Record<string, unknown>
      ).remarks,
    );

    expect(remarks).toContain('Budget: ₹5000000–₹?');
  });

  it('Privyr uses a placeholder name and omits an absent email', () => {
    const payload = new PrivyrAdapter().buildPayload(makeLead(SPARSE), 'manual') as Record<
      string,
      unknown
    >;

    expect(payload.name).toBe('GoSumo Lead');
    expect(payload.email).toBeUndefined();
  });
});

/**
 * `CrmAdapter.push` is documented as "must never throw — failures are
 * returned", and `CrmPushService` relies on that to decide retry vs. give-up.
 * An adapter that threw instead would surface as an unhandled rejection in the
 * queue processor rather than a recorded sync failure.
 */
describe('CRM adapters never throw out of push', () => {
  const LEAD = makeLead();

  it.each([
    ['SellDo', new SellDoAdapter(), { apiKey: 'k' } as Record<string, unknown>],
    [
      'LeadSquared',
      new LeadSquaredAdapter(),
      { accessKey: 'a', secretKey: 's' } as Record<string, unknown>,
    ],
    ['Privyr', new PrivyrAdapter(), { webhookUrl: 'https://hooks.privyr.com/abc' }],
  ])('%s returns a failure when the transport rejects', async (_name, adapter, config) => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

    const res = await adapter.push(config, LEAD, 'created');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('ECONNRESET');
  });

  it.each([
    ['SellDo', new SellDoAdapter(), { apiKey: 'k' } as Record<string, unknown>],
    [
      'LeadSquared',
      new LeadSquaredAdapter(),
      { accessKey: 'a', secretKey: 's' } as Record<string, unknown>,
    ],
    ['Privyr', new PrivyrAdapter(), { webhookUrl: 'https://hooks.privyr.com/abc' }],
  ])('%s stringifies a non-Error rejection', async (_name, adapter, config) => {
    global.fetch = jest.fn().mockRejectedValue('socket hang up') as unknown as typeof fetch;

    const res = await adapter.push(config, LEAD, 'created');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('socket hang up');
  });
});

describe('CRM adapter response handling', () => {
  it('LeadSquared treats a non-Success status body as a failure', async () => {
    // LeadSquared answers 200 with a body-level error for a rejected lead —
    // reading only the HTTP status would record a phantom successful sync.
    mockFetch({ ok: true, status: 200, body: { Status: 'Error', Message: { Id: 'x' } } });

    const res = await new LeadSquaredAdapter().push(
      { accessKey: 'a', secretKey: 's' },
      makeLead(),
      'created',
    );

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Error');
  });

  it('LeadSquared accepts a success body that carries no id', async () => {
    mockFetch({ ok: true, status: 200, body: { Status: 'Success' } });

    await expect(
      new LeadSquaredAdapter().push({ accessKey: 'a', secretKey: 's' }, makeLead(), 'created'),
    ).resolves.toEqual({ ok: true, externalId: undefined });
  });

  it('LeadSquared accepts a body with no status field at all', async () => {
    mockFetch({ ok: true, status: 200, body: {} });

    expect(
      (await new LeadSquaredAdapter().push({ accessKey: 'a', secretKey: 's' }, makeLead(), 'created'))
        .ok,
    ).toBe(true);
  });

  it('LeadSquared reports a non-2xx response', async () => {
    mockFetch({ ok: false, status: 401 });

    const res = await new LeadSquaredAdapter().push(
      { accessKey: 'a', secretKey: 's' },
      makeLead(),
      'created',
    );

    expect(res.ok).toBe(false);
    expect(res.error).toContain('401');
  });

  it('LeadSquared url-encodes credentials into the query string', async () => {
    // Keys containing `&` or `+` would otherwise truncate the query and send
    // a half-credential that reads as an auth failure.
    const fetchMock = mockFetch({ ok: true, status: 200, body: { Status: 'Success' } });

    await new LeadSquaredAdapter().push(
      { accessKey: 'a b&c', secretKey: 's/d' },
      makeLead(),
      'created',
    );

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('accessKey=a%20b%26c');
    expect(url).toContain('secretKey=s%2Fd');
  });

  it('LeadSquared honours a configured regional host', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { Status: 'Success' } });

    await new LeadSquaredAdapter().push(
      { accessKey: 'a', secretKey: 's', host: 'api-us11.leadsquared.com' },
      makeLead(),
      'created',
    );

    expect(fetchMock.mock.calls[0][0] as string).toContain('api-us11.leadsquared.com');
  });

  it('LeadSquared verify() requires both keys', async () => {
    const adapter = new LeadSquaredAdapter();

    expect(await adapter.verify({ accessKey: 'a', secretKey: 's' })).toEqual({ ok: true });
    expect((await adapter.verify({ accessKey: 'a' })).ok).toBe(false);
    expect((await adapter.verify({ secretKey: 's' })).ok).toBe(false);
    expect((await adapter.verify({})).ok).toBe(false);
  });

  it('SellDo falls back to lead_id when the response has no id', async () => {
    mockFetch({ ok: true, status: 200, body: { lead_id: 'sd-77' } });

    await expect(
      new SellDoAdapter().push({ apiKey: 'k' }, makeLead(), 'created'),
    ).resolves.toEqual({ ok: true, externalId: 'sd-77' });
  });

  it('SellDo succeeds with no external id when the body carries neither', async () => {
    mockFetch({ ok: true, status: 200, body: {} });

    await expect(
      new SellDoAdapter().push({ apiKey: 'k' }, makeLead(), 'created'),
    ).resolves.toEqual({ ok: true, externalId: undefined });
  });

  it('SellDo sends the api key as a header, not in the URL', async () => {
    // A key in the query string ends up in access logs and referrer headers.
    const fetchMock = mockFetch({ ok: true, status: 200, body: { id: 'x' } });

    await new SellDoAdapter().push({ apiKey: 'secret-key' }, makeLead(), 'created');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('secret-key');
  });

  it('SellDo honours a configured base URL', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { id: 'x' } });

    await new SellDoAdapter().push(
      { apiKey: 'k', baseUrl: 'https://staging.sell.do/api/leads/create' },
      makeLead(),
      'created',
    );

    expect(fetchMock.mock.calls[0][0]).toBe('https://staging.sell.do/api/leads/create');
  });

  it('Privyr reports a non-2xx response and makes no network call without a URL', async () => {
    mockFetch({ ok: false, status: 404 });
    const adapter = new PrivyrAdapter();

    const failed = await adapter.push({ webhookUrl: 'https://hooks.privyr.com/abc' }, makeLead(), 'created');
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('404');

    const fetchMock = mockFetch({ ok: true, status: 200 });
    expect((await adapter.push({}, makeLead(), 'created')).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
