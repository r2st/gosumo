/**
 * `use-compliance.ts` — the DPDPA surface: retention policy, right of access,
 * right to correction, right to erasure.
 *
 * Everything here is keyed on a buyer's **phone number**, which makes this the
 * one hook file where the cache key is user-supplied text rather than an opaque
 * id. Two consequences drive the tests:
 *
 *  - **The phone must be percent-encoded into the path.** Indian numbers are
 *    entered as `+919876543210` about as often as `919876543210`, and a raw `+`
 *    in a URL path is a space to some servers — the lookup would silently
 *    return another buyer's record, or none.
 *  - **The invalidation must use the same phone the operator typed.** A
 *    correction refreshes `['compliance','data-request', phone]`. If that key
 *    were built from the response instead of the input, the operator would
 *    correct a record and keep reading the pre-correction data — on the screen
 *    whose entire purpose is proving the correction happened.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-compliance';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const PHONE = '+919876543210';
const SETTINGS_KEY = ['compliance', 'settings'];

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: 'x' });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('useComplianceSettings', () => {
  it('requests the documented endpoint with an abort signal', async () => {
    const { result } = renderHook(() => hooks.useComplianceSettings(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/compliance/settings');
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});

describe('useDataRequest is gated on a submitted phone', () => {
  it.each([
    ['null', null],
    // The field starts empty. Firing would request
    // `/compliance/data-request/` — the collection route, if one existed — and
    // dump every buyer's record onto a page the operator only just opened.
    ['an empty string', ''],
  ])('does not look anyone up for %s', (_label, phone) => {
    const { result } = renderHook(() => hooks.useDataRequest(phone), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('percent-encodes the phone into the path', async () => {
    // A bare `+` in a path segment is decoded as a space by some servers, so
    // `+919876543210` would look up ` 919876543210` and find nothing — which
    // reads to the operator as "we hold no data on this person".
    const { result } = renderHook(() => hooks.useDataRequest(PHONE), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/compliance/data-request/%2B919876543210');
  });

  it('leaves a plain national-format number unchanged', async () => {
    const { result } = renderHook(() => hooks.useDataRequest('919876543210'), {
      wrapper: h.wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/compliance/data-request/919876543210');
  });

  it('looks up the new person when the operator searches again', async () => {
    const { result, rerender } = renderHook(
      ({ phone }: { phone: string }) => hooks.useDataRequest(phone),
      { wrapper: h.wrapper, initialProps: { phone: '919876543210' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ phone: '919999900000' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe('/compliance/data-request/919999900000');
  });

  it('keys each person’s record separately', async () => {
    // Two lookups in one session must not share a cache entry — serving one
    // buyer's personal data under another's number is the exact failure the
    // DPDPA screens exist to prevent.
    const first = renderHook(() => hooks.useDataRequest('919876543210'), { wrapper: h.wrapper });
    const second = renderHook(() => hooks.useDataRequest('919999900000'), { wrapper: h.wrapper });

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(
      h.queryClient.getQueryCache().findAll({ queryKey: ['compliance', 'data-request'] }),
    ).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('compliance mutation hooks call the documented endpoint', () => {
  it('useUpdateComplianceSettings PUTs the patch', async () => {
    const { result } = renderHook(() => hooks.useUpdateComplianceSettings(), {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync({ retentionMonths: 24, dataProcessorAgreement: true } as never);

    expect(apiRequest).toHaveBeenCalledWith('/compliance/settings', {
      method: 'PUT',
      body: { retentionMonths: 24, dataProcessorAgreement: true },
    });
  });

  it('useCorrection posts the correction whole', async () => {
    const input = { phone: PHONE, field: 'name', value: 'Asha Kumari' };
    const { result } = renderHook(() => hooks.useCorrection(), { wrapper: h.wrapper });

    await result.current.mutateAsync(input as never);

    expect(apiRequest).toHaveBeenCalledWith('/compliance/correction', {
      method: 'POST',
      body: input,
    });
  });

  it('useErasure posts the phone in the body, not the path', async () => {
    // Erasure is irreversible, so the phone travels as a body field where it
    // cannot be truncated by a proxy or land in an access log.
    const { result } = renderHook(() => hooks.useErasure(), { wrapper: h.wrapper });

    await result.current.mutateAsync(PHONE as never);

    expect(apiRequest).toHaveBeenCalledWith('/compliance/erasure', {
      method: 'POST',
      body: { phone: PHONE },
    });
  });

  it('useRunRetention posts an empty body rather than none', async () => {
    const { result } = renderHook(() => hooks.useRunRetention(), { wrapper: h.wrapper });

    await result.current.mutateAsync(undefined as never);

    expect(apiRequest).toHaveBeenCalledWith('/compliance/retention/run', {
      method: 'POST',
      body: {},
    });
  });
});

describe('mutations refresh exactly the record they changed', () => {
  it('useUpdateComplianceSettings seeds the response instead of refetching', async () => {
    const updated = { retentionMonths: 24, dataProcessorAgreement: true };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateComplianceSettings(), {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync({ retentionMonths: 24 } as never);

    expect(h.cacheWrites()).toEqual([[SETTINGS_KEY, updated]]);
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('useCorrection refreshes the record for the phone the operator submitted', async () => {
    // The key comes from the mutation input, not the response. Building it from
    // the response would leave the access view showing pre-correction data on
    // the very screen meant to evidence the correction.
    const { result } = renderHook(() => hooks.useCorrection(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ phone: PHONE, field: 'name', value: 'Asha' } as never);

    expect(h.invalidatedKeys()).toEqual([['compliance', 'data-request', PHONE]]);
  });

  it('useErasure refreshes the record it anonymised', async () => {
    const { result } = renderHook(() => hooks.useErasure(), { wrapper: h.wrapper });

    await result.current.mutateAsync(PHONE as never);

    expect(h.invalidatedKeys()).toEqual([['compliance', 'data-request', PHONE]]);
  });

  it('an erasure really does reach the open access view', async () => {
    // Asserting the key shape alone would not catch an off-by-one segment. This
    // checks the key the mutation emitted actually matches the cached query.
    const view = renderHook(() => hooks.useDataRequest(PHONE), { wrapper: h.wrapper });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useErasure(), { wrapper: h.wrapper });
    await result.current.mutateAsync(PHONE as never);

    const [key] = h.invalidatedKeys();
    expect(
      h.queryClient.getQueryCache().findAll({ queryKey: key as unknown[] }),
    ).toHaveLength(1);
  });

  it('an erasure leaves another buyer’s cached record alone', async () => {
    // The key carries the phone, so the invalidation is scoped to one person.
    // A bare `['compliance','data-request']` prefix would refetch — and so
    // re-request — personal data for everyone looked up this session.
    const other = renderHook(() => hooks.useDataRequest('919999900000'), { wrapper: h.wrapper });
    await waitFor(() => expect(other.result.current.isSuccess).toBe(true));
    const before = apiRequest.mock.calls.length;

    const { result } = renderHook(() => hooks.useErasure(), { wrapper: h.wrapper });
    await result.current.mutateAsync(PHONE as never);

    // One call for the erasure itself, and no refetch of the other record.
    expect(apiRequest.mock.calls.length).toBe(before + 1);
  });

  it('useRunRetention refreshes the settings card that reports the last sweep', async () => {
    const { result } = renderHook(() => hooks.useRunRetention(), { wrapper: h.wrapper });

    await result.current.mutateAsync(undefined as never);

    expect(h.invalidatedKeys()).toEqual([SETTINGS_KEY]);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed settings fetch lands in the error state', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useComplianceSettings(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a rejected erasure invalidates nothing', async () => {
    // Refetching would redraw the record unchanged and could be read as the
    // erasure having been carried out — the worst possible thing to be wrong
    // about on this screen.
    apiRequest.mockRejectedValueOnce(new Error('403 Owner only'));
    const { result } = renderHook(() => hooks.useErasure(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync(PHONE as never)).rejects.toThrow('403 Owner only');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('a rejected settings write leaves the cached policy alone', async () => {
    apiRequest.mockRejectedValueOnce(new Error('403 Owner only'));
    const { result } = renderHook(() => hooks.useUpdateComplianceSettings(), {
      wrapper: h.wrapper,
    });

    await expect(result.current.mutateAsync({ retentionMonths: 1 } as never)).rejects.toThrow(
      '403 Owner only',
    );
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});
