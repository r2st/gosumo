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
