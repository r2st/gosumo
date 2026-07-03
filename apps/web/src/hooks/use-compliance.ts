'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type {
  ComplianceSettings,
  CorrectionInput,
  DataAccessResult,
  ErasureResult,
  RetentionRunResult,
} from '@/lib/compliance-types';

const SETTINGS_KEY = ['compliance', 'settings'];

/** Retention policy + data-processor agreement status for this business. */
export function useComplianceSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => apiRequest<ComplianceSettings>('/compliance/settings', { signal }),
  });
}

export function useUpdateComplianceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { retentionMonths?: number; dataProcessorAgreement?: boolean }) =>
      apiRequest<ComplianceSettings>('/compliance/settings', { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_KEY, data);
    },
  });
}

/**
 * Right of access — everything held for a buyer phone. Query is gated on a
 * submitted phone so it only fires when the operator explicitly looks one up.
 */
export function useDataRequest(phone: string | null) {
  return useQuery({
    queryKey: ['compliance', 'data-request', phone],
    queryFn: ({ signal }) =>
      apiRequest<DataAccessResult>(
        `/compliance/data-request/${encodeURIComponent(phone ?? '')}`,
        { signal },
      ),
    enabled: !!phone,
  });
}

/** Right to correction — update a buyer's personal data. */
export function useCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CorrectionInput) =>
      apiRequest<{ id: string }>('/compliance/correction', { method: 'POST', body: input }),
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ['compliance', 'data-request', input.phone] });
    },
  });
}

/** Right to erasure — anonymize all PII held for a buyer phone. */
export function useErasure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phone: string) =>
      apiRequest<ErasureResult>('/compliance/erasure', { method: 'POST', body: { phone } }),
    onSuccess: (_data, phone) => {
      qc.invalidateQueries({ queryKey: ['compliance', 'data-request', phone] });
    },
  });
}

/** Manually run the retention sweep for this business now. */
export function useRunRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<RetentionRunResult>('/compliance/retention/run', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
}
