/**
 * Every endpoint on the typed `api` surface, checked for the three things that
 * are wrong silently: the path (a typo returns 404 at runtime, never at build),
 * the HTTP method, and the request body.
 *
 * `api-client.test.ts` covers the transport itself — headers, the 401 refresh,
 * the error envelope and the pagination shim.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, api } from './api-client';

function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

const fetchMock = vi.fn<typeof fetch>();

const ok = (body: unknown = {}): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }) as unknown as Response;

const url = (): string => String(fetchMock.mock.calls[0]?.[0]);
const opts = (): RequestInit => fetchMock.mock.calls[0]?.[1] as RequestInit;
const sentBody = (): unknown => {
  const raw = opts().body;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

beforeEach(() => {
  installLocalStorage();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Path + method for every endpoint that takes no body. Written as a table so a
 * new endpoint is one row, and a renamed route fails here rather than in prod.
 */
describe.each([
  ['auth.me', () => api.auth.me(), '/auth/me', 'GET'],
  ['business.me', () => api.business.me(), '/business/me', 'GET'],
  ['conversations.reopen', () => api.conversations.reopen('c1'), '/conversations/c1/reopen', 'POST'],
  ['hitl.get', () => api.hitl.get('t1'), '/hitl/tasks/t1', 'GET'],
  ['hitl.claim', () => api.hitl.claim('t1'), '/hitl/tasks/t1/claim', 'POST'],
  ['clients.get', () => api.clients.get('cl1'), '/clients/cl1', 'GET'],
  ['clients.segments', () => api.clients.segments(), '/clients/segments', 'GET'],
  ['orders.get', () => api.orders.get('o1'), '/orders/o1', 'GET'],
])('%s', (_name, call, path, method) => {
  it(`${method}s ${path}`, async () => {
    await call();
    expect(url()).toBe(`${API_BASE}${path}`);
    expect(opts().method ?? 'GET').toBe(method);
  });
});

describe('auth', () => {
  it('registers without an auth header — the account does not exist yet', async () => {
    const body = {
      businessName: 'Acme Realty',
      name: 'Asha',
      email: 'asha@acme.in',
      password: 'hunter2!A',
    };
    await api.auth.register(body);
    expect(url()).toBe(`${API_BASE}/auth/register`);
    expect(opts().method).toBe('POST');
    expect(sentBody()).toEqual(body);
    expect((opts().headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('passes the optional phone through on register', async () => {
    await api.auth.register({
      businessName: 'Acme',
      name: 'Asha',
      email: 'a@b.in',
      password: 'p',
      phone: '+919800000001',
    });
    expect(sentBody()).toMatchObject({ phone: '+919800000001' });
  });

  it('requests a password reset by email only', async () => {
    await api.auth.forgotPassword('asha@acme.in');
    expect(url()).toBe(`${API_BASE}/auth/password/forgot`);
    expect(sentBody()).toEqual({ email: 'asha@acme.in' });
  });

  it('resets the password with the emailed token', async () => {
    await api.auth.resetPassword('tok-123', 'newPass!1');
    expect(url()).toBe(`${API_BASE}/auth/password/reset`);
    expect(sentBody()).toEqual({ token: 'tok-123', newPassword: 'newPass!1' });
  });

  it('logs out by refresh token, so the server can revoke that session', async () => {
    await api.auth.logout('refresh-1');
    expect(url()).toBe(`${API_BASE}/auth/logout`);
    expect(sentBody()).toEqual({ refreshToken: 'refresh-1' });
  });
});

describe('conversations', () => {
  it('fetches a page of messages with an explicit default limit', async () => {
    await api.conversations.messages('c1');
    expect(url()).toBe(`${API_BASE}/conversations/c1/messages?limit=50`);
  });

  it('honours an overridden message limit', async () => {
    await api.conversations.messages('c1', 200);
    expect(url()).toBe(`${API_BASE}/conversations/c1/messages?limit=200`);
  });

  it('resolves with the operator’s resolution note', async () => {
    await api.conversations.resolve('c1', 'sent the brochure');
    expect(url()).toBe(`${API_BASE}/conversations/c1/resolve`);
    expect(sentBody()).toEqual({ resolution: 'sent the brochure' });
  });

  it('resolves without a note', async () => {
    await api.conversations.resolve('c1');
    expect(sentBody()).toEqual({});
  });

  it('reopens with an empty body rather than none, so Content-Type is set', async () => {
    await api.conversations.reopen('c1');
    expect(sentBody()).toEqual({});
    expect((opts().headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('escalates with a reason and priority', async () => {
    await api.conversations.escalate('c1', 'buyer wants a discount', 'HIGH');
    expect(url()).toBe(`${API_BASE}/conversations/c1/escalate`);
    expect(sentBody()).toEqual({ reason: 'buyer wants a discount', priority: 'HIGH' });
  });

  it('escalates without a priority, leaving the default to the server', async () => {
    await api.conversations.escalate('c1', 'needs a human');
    expect(sentBody()).toEqual({ reason: 'needs a human' });
  });

  it('assigns a conversation to a user', async () => {
    await api.conversations.assign('c1', 'u1');
    expect(url()).toBe(`${API_BASE}/conversations/c1/assign`);
    expect(sentBody()).toEqual({ userId: 'u1' });
  });

  it('PATCHes a partial update rather than replacing the conversation', async () => {
    await api.conversations.update('c1', { status: 'RESOLVED', tags: ['vip'] });
    expect(url()).toBe(`${API_BASE}/conversations/c1`);
    expect(opts().method).toBe('PATCH');
    expect(sentBody()).toEqual({ status: 'RESOLVED', tags: ['vip'] });
  });

  it('can clear an assignment by patching null', async () => {
    await api.conversations.update('c1', { assignedTo: null });
    expect(sentBody()).toEqual({ assignedTo: null });
  });
});

describe('hitl tasks', () => {
  it('lists with filters', async () => {
    await api.hitl.list({ status: 'PENDING', priority: 'HIGH', page: 2 });
    expect(url()).toBe(`${API_BASE}/hitl/tasks?status=PENDING&priority=HIGH&page=2`);
  });

  it('lists with no filters at all', async () => {
    await api.hitl.list();
    expect(url()).toBe(`${API_BASE}/hitl/tasks`);
  });

  it('approves the AI draft as written', async () => {
    await api.hitl.approve('t1');
    expect(url()).toBe(`${API_BASE}/hitl/tasks/t1/approve`);
    expect(sentBody()).toEqual({});
  });

  it('approves an edited draft, sending the operator’s text', async () => {
    await api.hitl.approve('t1', 'Rewritten reply');
    expect(sentBody()).toEqual({ editedResponse: 'Rewritten reply' });
  });

  it('rejects with a reason', async () => {
    await api.hitl.reject('t1', 'wrong price');
    expect(url()).toBe(`${API_BASE}/hitl/tasks/t1/reject`);
    expect(sentBody()).toEqual({ reason: 'wrong price' });
  });

  it('rejects without a reason', async () => {
    await api.hitl.reject('t1');
    expect(sentBody()).toEqual({});
  });

  it('claims with an empty body', async () => {
    await api.hitl.claim('t1');
    expect(sentBody()).toEqual({});
  });
});

describe('clients', () => {
  it('lists with filters, joining array tags', async () => {
    await api.clients.list({ q: 'asha', tags: ['vip', 'repeat'], hasOrders: true });
    expect(url()).toBe(`${API_BASE}/clients?q=asha&tags=vip%2Crepeat&hasOrders=true`);
  });

  it('includes related resources on a single client', async () => {
    await api.clients.get('cl1', ['orders', 'conversations']);
    expect(url()).toBe(`${API_BASE}/clients/cl1?include=orders%2Cconversations`);
  });

  it('fetches the timeline with a default limit', async () => {
    await api.clients.timeline('cl1');
    expect(url()).toBe(`${API_BASE}/clients/cl1/timeline?limit=30`);
  });

  it('honours an overridden timeline limit', async () => {
    await api.clients.timeline('cl1', 5);
    expect(url()).toBe(`${API_BASE}/clients/cl1/timeline?limit=5`);
  });
});

describe('catalog, orders, bookings and payments', () => {
  it('lists catalog items with filters', async () => {
    await api.catalog.items({ q: '2bhk', type: 'PROPERTY', limit: 10 });
    expect(url()).toBe(`${API_BASE}/catalog/items?q=2bhk&type=PROPERTY&limit=10`);
  });

  it('lists catalog items unfiltered', async () => {
    await api.catalog.items();
    expect(url()).toBe(`${API_BASE}/catalog/items`);
  });

  it('lists orders filtered by status', async () => {
    await api.orders.list({ status: 'PAID', page: 3 });
    expect(url()).toBe(`${API_BASE}/orders?status=PAID&page=3`);
  });

  it('lists orders unfiltered', async () => {
    await api.orders.list();
    expect(url()).toBe(`${API_BASE}/orders`);
  });

  it('lists bookings across a date range', async () => {
    await api.bookings.list({ from: '2026-08-01', to: '2026-08-31', status: 'CONFIRMED' });
    expect(url()).toBe(
      `${API_BASE}/bookings?from=2026-08-01&to=2026-08-31&status=CONFIRMED`,
    );
  });

  it('lists bookings unfiltered', async () => {
    await api.bookings.list();
    expect(url()).toBe(`${API_BASE}/bookings`);
  });

  it('lists payments by status and method', async () => {
    await api.payments.list({ status: 'CAPTURED', method: 'UPI' });
    expect(url()).toBe(`${API_BASE}/payments?status=CAPTURED&method=UPI`);
  });

  it('lists payments unfiltered', async () => {
    await api.payments.list();
    expect(url()).toBe(`${API_BASE}/payments`);
  });
});

describe('analytics', () => {
  it('fetches the dashboard over a date range', async () => {
    await api.analytics.dashboard({ from: '2026-08-01', to: '2026-08-14' });
    expect(url()).toBe(`${API_BASE}/analytics/dashboard?from=2026-08-01&to=2026-08-14`);
  });

  it('fetches the dashboard with no range, leaving the default to the server', async () => {
    await api.analytics.dashboard();
    expect(url()).toBe(`${API_BASE}/analytics/dashboard`);
  });

  it('fetches the conversation report at a granularity', async () => {
    await api.analytics.conversations({ from: '2026-08-01', granularity: 'day' });
    expect(url()).toBe(`${API_BASE}/analytics/conversations?from=2026-08-01&granularity=day`);
  });

  it('fetches the conversation report with no params', async () => {
    await api.analytics.conversations();
    expect(url()).toBe(`${API_BASE}/analytics/conversations`);
  });

  it('fetches the revenue report at a granularity', async () => {
    await api.analytics.revenue({ to: '2026-08-14', granularity: 'week' });
    expect(url()).toBe(`${API_BASE}/analytics/revenue?to=2026-08-14&granularity=week`);
  });

  it('fetches the revenue report with no params', async () => {
    await api.analytics.revenue();
    expect(url()).toBe(`${API_BASE}/analytics/revenue`);
  });
});

describe('abort signals', () => {
  it('threads the caller’s abort signal into the list requests', async () => {
    const controller = new AbortController();
    await api.conversations.list({}, controller.signal);
    expect(opts().signal).toBe(controller.signal);
  });

  it('leaves the signal unset when the caller does not pass one', async () => {
    await api.orders.list({});
    expect(opts().signal).toBeUndefined();
  });
});
