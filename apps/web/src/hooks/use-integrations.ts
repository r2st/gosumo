'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPaginated, apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type {
  ApiKey,
  CreatedApiKey,
  IntegrationCredential,
  IntegrationProvider,
  SaveIntegrationRequest,
  TestConnectionResult,
} from '@/lib/integration-types';

const CRED_KEY = ['integrations', 'credentials'];
const API_KEYS_KEY = ['api-keys'];

/** All third-party credential configs, keyed by provider for easy lookup. */
export function useIntegrationCredentials() {
  return useQuery({
    queryKey: CRED_KEY,
    queryFn: async () => {
      const res = await apiRequest<{ integrations: IntegrationCredential[] }>('/integrations/credentials');
      const byProvider = {} as Record<IntegrationProvider, IntegrationCredential>;
      for (const cred of res.integrations) byProvider[cred.provider] = cred;
      return byProvider;
    },
  });
}

export function useSaveIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, body }: { provider: IntegrationProvider; body: SaveIntegrationRequest }) =>
      apiRequest<IntegrationCredential>(`/integrations/credentials/${provider}`, { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CRED_KEY }),
  });
}

export function useTestIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, body }: { provider: IntegrationProvider; body?: SaveIntegrationRequest }) =>
      apiRequest<TestConnectionResult>(`/integrations/credentials/${provider}/test`, {
        method: 'POST',
        body: body ?? {},
      }),
    // A test updates the stored status; refresh so the badge reflects it.
    onSuccess: () => qc.invalidateQueries({ queryKey: CRED_KEY }),
  });
}

// ── GoSumo API keys ─────────────────────────────────────────────────────────
export function useApiKeys() {
  return useQuery({
    queryKey: API_KEYS_KEY,
    queryFn: () => apiPaginated<ApiKey>(`/api-keys${toQuery({ limit: 100 })}`),
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[] }) =>
      apiRequest<CreatedApiKey>('/api-keys', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: API_KEYS_KEY }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: API_KEYS_KEY }),
  });
}
