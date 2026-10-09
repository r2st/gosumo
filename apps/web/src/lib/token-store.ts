// ─────────────────────────────────────────────────────────────────────────────
// Token store.
//
// Per the dashboard security guidance, the **access token is kept in memory only**
// (never localStorage). The refresh token is persisted so a session survives a
// page reload; in production the backend also sets it as an HttpOnly cookie and
// the silent-refresh call relies on that. We mirror it in localStorage here so the
// SPA can bootstrap a session without the cookie during local development.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_KEY = 'desk.refreshToken';
const LEGACY_REFRESH_KEY = 'gosumo.refreshToken';

function migrateRefreshToken(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const old = window.localStorage.getItem(LEGACY_REFRESH_KEY);
  if (old && !window.localStorage.getItem(REFRESH_KEY)) {
    window.localStorage.setItem(REFRESH_KEY, old);
    window.localStorage.removeItem(LEGACY_REFRESH_KEY);
  }
}
migrateRefreshToken();

let accessToken: string | null = null;

export const tokenStore = {
  getAccessToken(): string | null {
    return accessToken;
  },
  setAccessToken(token: string | null): void {
    accessToken = token;
  },
  getRefreshToken(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(REFRESH_KEY);
  },
  setRefreshToken(token: string | null): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (token) window.localStorage.setItem(REFRESH_KEY, token);
    else window.localStorage.removeItem(REFRESH_KEY);
  },
  clear(): void {
    accessToken = null;
    this.setRefreshToken(null);
  },
};
