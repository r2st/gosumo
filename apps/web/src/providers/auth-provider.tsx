'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setOnAuthFailure } from '@/lib/api-client';
import { tokenStore } from '@/lib/token-store';
import type { AuthUser, BusinessProfile, LoginResult } from '@/lib/types';

interface AuthState {
  user: AuthUser | null;
  business: BusinessProfile | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
}

interface AuthContextValue extends AuthState {
  /** Returns true when fully logged in, false when the API requires a 2FA step. */
  login: (email: string, password: string) => Promise<boolean>;
  register: (body: {
    businessName: string;
    name: string;
    email: string;
    password: string;
    phone?: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    user: null,
    business: null,
    status: 'loading',
  });

  const loadSession = useCallback(async () => {
    try {
      const [user, business] = await Promise.all([
        api.auth.me(),
        api.business.me().catch(() => null),
      ]);
      setState({ user, business, status: 'authenticated' });
    } catch {
      setState({ user: null, business: null, status: 'unauthenticated' });
    }
  }, []);

  // On mount, if we have a refresh token, bootstrap the session silently.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!tokenStore.getRefreshToken()) {
        if (active) setState((s) => ({ ...s, status: 'unauthenticated' }));
        return;
      }
      // Trigger a refresh by hitting an authed endpoint; the client refreshes on 401.
      await loadSession();
    })();
    return () => {
      active = false;
    };
  }, [loadSession]);

  // When the API client can no longer refresh, force the user back to login.
  useEffect(() => {
    setOnAuthFailure(() => {
      tokenStore.clear();
      setState({ user: null, business: null, status: 'unauthenticated' });
      router.replace('/login');
    });
  }, [router]);

  const applyLoginResult = useCallback(async (result: LoginResult): Promise<boolean> => {
    if (result.requiresTwoFactor) {
      return false;
    }
    tokenStore.setAccessToken(result.tokens.accessToken);
    tokenStore.setRefreshToken(result.tokens.refreshToken);
    const business = await api.business.me().catch(() => null);
    setState({ user: result.user, business, status: 'authenticated' });
    return true;
  }, []);

  const login = useCallback(
    async (email: string, password: string) =>
      applyLoginResult(await api.auth.login(email, password)),
    [applyLoginResult],
  );

  const register = useCallback(
    async (body: {
      businessName: string;
      name: string;
      email: string;
      password: string;
      phone?: string;
    }) => applyLoginResult(await api.auth.register(body)),
    [applyLoginResult],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.getRefreshToken();
    if (refreshToken) await api.auth.logout(refreshToken).catch(() => undefined);
    tokenStore.clear();
    setState({ user: null, business: null, status: 'unauthenticated' });
    router.replace('/login');
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout, refreshProfile: loadSession }),
    [state, login, register, logout, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

/**
 * The session if there is a provider above, otherwise null.
 *
 * {@link useAuth} throws so that a component depending on the session fails
 * loudly when it is mounted outside the dashboard shell. Permission checks
 * want the opposite: a missing provider should mean "no role, so no write
 * controls", not a crashed subtree. Read-only is the safe reading of an
 * unknown session, and it keeps a component that merely *hides a button*
 * based on role renderable in isolation.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
