import { tokenStore } from './token-store';
import { toQuery } from './utils';
import type {
  ApiErrorBody,
  AuthUser,
  Booking,
  BookingStatus,
  BusinessProfile,
  CatalogItem,
  Client,
  ClientSegment,
  ClientTimeline,
  Conversation,
  ConversationReport,
  ConversationStatus,
  DashboardMetrics,
  HitlPriority,
  HitlTask,
  HitlTaskStatus,
  LoginResult,
  Message,
  Order,
  OrderStatus,
  PaginatedResponse,
  Payment,
  PaymentStatus,
  RevenueReport,
  TokenPair,
} from './types';

const RAW_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
/** Full API root including the version prefix documented in API_DESIGN.md. */
export const API_BASE = `${RAW_BASE.replace(/\/$/, '')}/v1`;

/** Error thrown for any non-2xx API response. Carries the parsed error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body?: ApiErrorBody;

  constructor(status: number, code: string, message: string, body?: ApiErrorBody) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Public endpoints (login, refresh, password reset) skip the auth header. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Internal — prevents infinite refresh recursion. */
  _retry?: boolean;
}

let refreshPromise: Promise<boolean> | null = null;

/** Exchange the stored refresh token for a fresh access token. De-duped across callers. */
async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          tokenStore.clear();
          return false;
        }
        const tokens = (await res.json()) as TokenPair;
        tokenStore.setAccessToken(tokens.accessToken);
        if (tokens.refreshToken) tokenStore.setRefreshToken(tokens.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/** Called by the auth layer when a refresh ultimately fails, to force re-login. */
let onAuthFailure: (() => void) | null = null;
export function setOnAuthFailure(handler: () => void): void {
  onAuthFailure = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal, _retry = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = tokenStore.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the GoSumo Realty API. Is it running?');
  }

  // Transparently refresh once on a 401, then replay the request.
  if (res.status === 401 && auth && !_retry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, { ...options, _retry: true });
    }
    onAuthFailure?.();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const errBody = data as ApiErrorBody | undefined;
    throw new ApiError(
      res.status,
      errBody?.error ?? 'ERROR',
      errBody?.message ?? `Request failed with status ${res.status}`,
      errBody,
    );
  }

  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Fetch a list endpoint and return it in the frontend's `{ data, pagination }`
 * shape.
 *
 * Always use this instead of `apiRequest<PaginatedResponse<T>>` for a list
 * route. `apiRequest` casts, it does not convert — so asking it for a
 * `PaginatedResponse<T>` from a backend that answers with flat fields hands
 * back an object whose `pagination` is `undefined` while the type says
 * otherwise. Anything that then reads `data.pagination.total` throws at
 * runtime, and no test catches it because the mock supplies the shape the type
 * promised.
 */
export async function apiPaginated<T>(
  path: string,
  options?: RequestOptions,
): Promise<PaginatedResponse<T>> {
  return normalizePaginated<T>(await request<unknown>(path, options));
}

/**
 * Normalize a paginated API response. The backend returns flat pagination
 * fields ({ data, total, page, limit, totalPages }) but the frontend types
 * expect a nested { data, pagination } envelope. This function bridges the gap.
 */
function normalizePaginated<T>(raw: unknown): PaginatedResponse<T> {
  const obj = raw as Record<string, unknown>;
  if (obj.pagination) return obj as unknown as PaginatedResponse<T>;
  return {
    data: (obj.data ?? []) as T[],
    pagination: {
      total: (obj.total as number) ?? 0,
      limit: (obj.limit as number) ?? 20,
      page: (obj.page as number) ?? 1,
      totalPages: (obj.totalPages as number) ?? 1,
      hasMore: ((obj.page as number) ?? 1) < ((obj.totalPages as number) ?? 1),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed endpoint surface, grouped by resource.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationFilters {
  status?: ConversationStatus | ConversationStatus[];
  channelType?: string;
  assignedTo?: string;
  q?: string;
  page?: number;
  limit?: number;
  include?: string;
}

export interface ClientFilters {
  q?: string;
  churnRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  source?: string;
  tags?: string[];
  hasOrders?: boolean;
  include?: string;
  page?: number;
  limit?: number;
}

export interface HitlFilters {
  status?: HitlTaskStatus | HitlTaskStatus[];
  type?: string;
  priority?: HitlPriority;
  assignedTo?: string;
  include?: string;
  page?: number;
  limit?: number;
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    login: (email: string, password: string) =>
      request<LoginResult>('/auth/login', { method: 'POST', auth: false, body: { email, password } }),
    register: (body: {
      businessName: string;
      name: string;
      email: string;
      password: string;
      phone?: string;
    }) => request<LoginResult>('/auth/register', { method: 'POST', auth: false, body }),
    forgotPassword: (email: string) =>
      request<{ message: string }>('/auth/password/forgot', {
        method: 'POST',
        auth: false,
        body: { email },
      }),
    resetPassword: (token: string, newPassword: string) =>
      request<TokenPair>('/auth/password/reset', {
        method: 'POST',
        auth: false,
        body: { token, newPassword },
      }),
    logout: (refreshToken: string) =>
      request<void>('/auth/logout', { method: 'POST', body: { refreshToken } }),
    me: () => request<AuthUser>('/auth/me'),
    /** Conventional redirect targets for OAuth flows. */
    googleUrl: () => `${API_BASE}/auth/google`,
    githubUrl: () => `${API_BASE}/auth/github`,
    microsoftUrl: () => `${API_BASE}/auth/microsoft`,
  },

  // ── Business / tenant ───────────────────────────────────────────────────────
  business: {
    me: () => request<BusinessProfile>('/business/me'),
  },

  // ── Conversations ───────────────────────────────────────────────────────────
  conversations: {
    list: (filters: ConversationFilters = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<Conversation>>(`/conversations${toQuery({ ...filters })}`, { signal }),
    get: (id: string, include?: string[]) =>
      request<Conversation>(`/conversations/${id}${toQuery({ include })}`),
    messages: (id: string, limit = 50) =>
      request<PaginatedResponse<Message>>(`/conversations/${id}/messages${toQuery({ limit })}`),
    sendMessage: (id: string, text: string) =>
      request<Message>(`/conversations/${id}/messages`, {
        method: 'POST',
        body: { content: { type: 'TEXT', text } },
      }),
    resolve: (id: string, resolution?: string) =>
      request<Conversation>(`/conversations/${id}/resolve`, { method: 'POST', body: { resolution } }),
    reopen: (id: string) => request<Conversation>(`/conversations/${id}/reopen`, { method: 'POST', body: {} }),
    escalate: (id: string, reason: string, priority?: HitlPriority) =>
      request<{ conversation: Conversation; task: HitlTask }>(`/conversations/${id}/escalate`, {
        method: 'POST',
        body: { reason, priority },
      }),
    assign: (id: string, userId: string) =>
      request<Conversation>(`/conversations/${id}/assign`, { method: 'POST', body: { userId } }),
    markRead: (id: string) =>
      request<Conversation & { cleared: number }>(`/conversations/${id}/read`, {
        method: 'POST',
        body: {},
      }),
    update: (id: string, body: { status?: ConversationStatus; assignedTo?: string | null; tags?: string[] }) =>
      request<Conversation>(`/conversations/${id}`, { method: 'PATCH', body }),
  },

  // ── HITL tasks ──────────────────────────────────────────────────────────────
  hitl: {
    list: (filters: HitlFilters = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<HitlTask>>(`/hitl/tasks${toQuery({ ...filters })}`, { signal }),
    get: (id: string) => request<HitlTask>(`/hitl/tasks/${id}`),
    approve: (id: string, editedResponse?: string) =>
      request<{ task: HitlTask; message?: Message }>(`/hitl/tasks/${id}/approve`, {
        method: 'POST',
        body: { editedResponse },
      }),
    reject: (id: string, reason?: string) =>
      request<HitlTask>(`/hitl/tasks/${id}/reject`, { method: 'POST', body: { reason } }),
    claim: (id: string) => request<HitlTask>(`/hitl/tasks/${id}/claim`, { method: 'POST', body: {} }),
  },

  // ── Clients ─────────────────────────────────────────────────────────────────
  clients: {
    list: async (filters: ClientFilters = {}, signal?: AbortSignal) =>
      normalizePaginated<Client>(await request<unknown>(`/clients${toQuery({ ...filters })}`, { signal })),
    get: (id: string, include?: string[]) =>
      request<Client>(`/clients/${id}${toQuery({ include })}`),
    timeline: (id: string, limit = 30) =>
      request<ClientTimeline>(`/clients/${id}/timeline${toQuery({ limit })}`),
    segments: () => request<{ segments: ClientSegment[] }>('/clients/segments'),
  },

  // ── Catalog ─────────────────────────────────────────────────────────────────
  catalog: {
    items: (filters: { q?: string; type?: string; page?: number; limit?: number } = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<CatalogItem>>(`/catalog/items${toQuery({ ...filters })}`, { signal }),
  },

  // ── Orders ──────────────────────────────────────────────────────────────────
  orders: {
    list: (filters: { status?: OrderStatus; q?: string; page?: number; limit?: number } = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<Order>>(`/orders${toQuery({ ...filters })}`, { signal }),
    get: (id: string) => request<Order>(`/orders/${id}`),
  },

  // ── Bookings ────────────────────────────────────────────────────────────────
  bookings: {
    list: (filters: { status?: BookingStatus; date?: string; from?: string; to?: string; page?: number; limit?: number; include?: string } = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<Booking>>(`/bookings${toQuery({ ...filters })}`, { signal }),
  },

  // ── Payments ────────────────────────────────────────────────────────────────
  payments: {
    list: (filters: { status?: PaymentStatus; method?: string; page?: number; limit?: number } = {}, signal?: AbortSignal) =>
      request<PaginatedResponse<Payment>>(`/payments${toQuery({ ...filters })}`, { signal }),
  },

  // ── Analytics ───────────────────────────────────────────────────────────────
  analytics: {
    dashboard: (params: { from?: string; to?: string } = {}) =>
      request<DashboardMetrics>(`/analytics/dashboard${toQuery({ ...params })}`),
    conversations: (params: { from?: string; to?: string; granularity?: string } = {}) =>
      request<ConversationReport>(`/analytics/conversations${toQuery({ ...params })}`),
    revenue: (params: { from?: string; to?: string; granularity?: string } = {}) =>
      request<RevenueReport>(`/analytics/revenue${toQuery({ ...params })}`),
  },
};

export { request as apiRequest };
