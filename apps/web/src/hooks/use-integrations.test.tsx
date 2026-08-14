/**
 * `use-integrations.ts` — third-party credentials and GoSumo's own API keys.
 *
 * `useIntegrationCredentials` is the only hook in the codebase that reshapes
 * its response: the API returns `{ integrations: [...] }` and the hook rekeys
 * it into a `Record<provider, credential>` so a settings card can look up its
 * own provider without scanning. That transform is real logic, and the tests
 * below cover what it does with an empty list and with duplicate providers.
 *
 * `useTestIntegration` is the other thing worth pinning. Testing a connection
 * reads like a pure check, but the API records the outcome, so the hook has to
 * invalidate the credential list or the status badge keeps showing the result
 * of the *previous* test.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-integrations';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const CRED_KEY = ['integrations', 'credentials'];
const API_KEYS_KEY = ['api-keys'];
const KEY_ID = 'key-1';

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ integrations: [], data: [] });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('useIntegrationCredentials', () => {
  it('requests the documented endpoint', async () => {
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledWith('/integrations/credentials');
  });

  it('rekeys the array by provider so a card can look up its own row', async () => {
    // Each settings card knows its provider and nothing else. Without this the
    // card would have to scan the array, and every card would repeat the scan.
    apiRequest.mockResolvedValueOnce({
      integrations: [
        { provider: 'RAZORPAY', status: 'CONNECTED' },
        { provider: 'OPENROUTER', status: 'ERROR' },
      ],
    });
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      RAZORPAY: { provider: 'RAZORPAY', status: 'CONNECTED' },
      OPENROUTER: { provider: 'OPENROUTER', status: 'ERROR' },
    });
  });

  it('yields an empty map for a business that has configured nothing', async () => {
    // A fresh tenant gets `{ integrations: [] }`. The map must still be an
    // object — the cards index into it unconditionally, so undefined here
    // would throw on first paint of the settings page.
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({});
  });

  it('lets the last row win if the API ever returns a provider twice', async () => {
    // Not expected, but the reduce is last-write-wins rather than a throw, so a
    // duplicate degrades to showing one row instead of breaking the page.
    apiRequest.mockResolvedValueOnce({
      integrations: [
        { provider: 'RAZORPAY', status: 'ERROR' },
        { provider: 'RAZORPAY', status: 'CONNECTED' },
      ],
    });
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      RAZORPAY: { provider: 'RAZORPAY', status: 'CONNECTED' },
    });
  });
});

describe('useApiKeys', () => {
  it('asks for a page big enough that "load more" never has to exist', async () => {
    const { result } = renderHook(() => hooks.useApiKeys(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledWith('/api-keys?limit=100');
  });

  it('caches under a key separate from the credential list', async () => {
    // The two lists render on the same page; a shared key would put API keys
    // through the provider-rekeying transform.
    const creds = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });
    const keys = renderHook(() => hooks.useApiKeys(), { wrapper: h.wrapper });

    await waitFor(() => expect(creds.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(keys.result.current.isSuccess).toBe(true));

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(h.queryClient.getQueryCache().findAll({ queryKey: API_KEYS_KEY })).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('integration mutation hooks call the documented endpoint', () => {
  it('useSaveIntegration PUTs to the provider path', async () => {
    const { result } = renderHook(() => hooks.useSaveIntegration(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      provider: 'RAZORPAY',
      body: { keyId: 'rzp_test_x', keySecret: 's3cret' },
    } as never);

    expect(apiRequest).toHaveBeenCalledWith('/integrations/credentials/RAZORPAY', {
      method: 'PUT',
      body: { keyId: 'rzp_test_x', keySecret: 's3cret' },
    });
  });

  it('useTestIntegration posts the unsaved credentials when testing before save', async () => {
    // The form lets an operator verify keys they have typed but not stored, so
    // the candidate credentials ride along with the test.
    const { result } = renderHook(() => hooks.useTestIntegration(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      provider: 'RAZORPAY',
      body: { keyId: 'rzp_test_x', keySecret: 's3cret' },
    } as never);

    expect(apiRequest).toHaveBeenCalledWith('/integrations/credentials/RAZORPAY/test', {
      method: 'POST',
      body: { keyId: 'rzp_test_x', keySecret: 's3cret' },
    });
  });

  it('useTestIntegration posts an empty object when re-testing what is stored', async () => {
    // `body ?? {}` — not `body`. A missing body would make `apiRequest` skip
    // the Content-Type header and send no payload, which the API reads
    // differently from "test the saved credentials".
    const { result } = renderHook(() => hooks.useTestIntegration(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ provider: 'OPENROUTER' } as never);

    expect(apiRequest).toHaveBeenCalledWith('/integrations/credentials/OPENROUTER/test', {
      method: 'POST',
      body: {},
    });
  });

  it('useCreateApiKey posts the name and scopes', async () => {
    const { result } = renderHook(() => hooks.useCreateApiKey(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ name: 'Ops dashboard', scopes: ['orders:read'] } as never);

    expect(apiRequest).toHaveBeenCalledWith('/api-keys', {
      method: 'POST',
      body: { name: 'Ops dashboard', scopes: ['orders:read'] },
    });
  });

  it('useRevokeApiKey deletes by id', async () => {
    const { result } = renderHook(() => hooks.useRevokeApiKey(), { wrapper: h.wrapper });

    await result.current.mutateAsync(KEY_ID as never);

    expect(apiRequest).toHaveBeenCalledWith(`/api-keys/${KEY_ID}`, { method: 'DELETE' });
  });
});

describe('mutations refresh exactly the views their change affects', () => {
  it.each([
    [
      'useSaveIntegration',
      () => hooks.useSaveIntegration(),
      { provider: 'RAZORPAY', body: {} },
    ],
    ['useTestIntegration', () => hooks.useTestIntegration(), { provider: 'RAZORPAY' }],
  ])('%s refreshes the credential list', async (_name, run, vars) => {
    // Testing a connection looks like a read, but the API stores the outcome —
    // so without this the status badge shows the *previous* test's result.
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([CRED_KEY]);
  });

  it.each([
    ['useCreateApiKey', () => hooks.useCreateApiKey(), { name: 'k', scopes: [] }],
    ['useRevokeApiKey', () => hooks.useRevokeApiKey(), KEY_ID],
  ])('%s refreshes the API key list only', async (_name, run, vars) => {
    // API keys and third-party credentials are unrelated resources on a shared
    // page; refreshing both would re-request secrets nothing asked about.
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([API_KEYS_KEY]);
  });

  it('does not cache the one-time secret a new key returns', async () => {
    // `CreatedApiKey` carries the plaintext key, shown once. Seeding it into
    // the cache would leave the secret readable from the list query for the
    // rest of the session.
    apiRequest.mockResolvedValueOnce({ id: KEY_ID, key: 'gsk_live_plaintext' });
    const { result } = renderHook(() => hooks.useCreateApiKey(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ name: 'k', scopes: [] } as never);

    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
    expect(h.queryClient.getQueryData(API_KEYS_KEY)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed credential fetch lands in the error state', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a malformed credential response errors rather than rendering a broken page', async () => {
    // The transform iterates `res.integrations`. If the API ever answered
    // without it, failing inside the query function puts the settings page in
    // its error state instead of throwing during render.
    apiRequest.mockResolvedValueOnce({});
    const { result } = renderHook(() => hooks.useIntegrationCredentials(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('a rejected save does not refresh the credential list', async () => {
    // Refetching would replace the validation error with the stored values and
    // read as though the bad keys had been accepted.
    apiRequest.mockRejectedValueOnce(new Error('400 Invalid key format'));
    const { result } = renderHook(() => hooks.useSaveIntegration(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ provider: 'RAZORPAY', body: {} } as never),
    ).rejects.toThrow('400 Invalid key format');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
