'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPaginated, apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { Payment, PaymentRefund } from '@/lib/types';
import type {
  CreatePaymentLinkRequest,
  PaymentLinkResponse,
  PaymentListQuery,
  PaymentStats,
  RefundRequest,
} from '@/lib/commerce-types';

const PAYMENTS_KEY = ['payments'];

export function usePayments(filters: PaymentListQuery = {}) {
  return useQuery({
    queryKey: [...PAYMENTS_KEY, filters],
    queryFn: ({ signal }) => apiPaginated<Payment>(`/payments${toQuery({ ...filters })}`, { signal }),
  });
}

export function usePayment(id: string | null) {
  return useQuery({
    queryKey: ['payment', id],
    queryFn: () => apiRequest<Payment>(`/payments/${id}`),
    enabled: !!id,
  });
}

export function usePaymentStats(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['payments', 'stats', params],
    queryFn: () => apiRequest<PaymentStats>(`/payments/stats${toQuery({ ...params })}`),
  });
}

function invalidatePayments(qc: ReturnType<typeof useQueryClient>, id?: string) {
  qc.invalidateQueries({ queryKey: PAYMENTS_KEY });
  if (id) qc.invalidateQueries({ queryKey: ['payment', id] });
}

export function useCreatePaymentLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePaymentLinkRequest) =>
      apiRequest<PaymentLinkResponse>('/payments/link', { method: 'POST', body }),
    onSuccess: () => invalidatePayments(qc),
  });
}

export function useRefundPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & RefundRequest) =>
      apiRequest<PaymentRefund>(`/payments/${id}/refund`, { method: 'POST', body }),
    onSuccess: (_d, vars) => invalidatePayments(qc, vars.id),
  });
}

export function useCapturePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount }: { id: string; amount?: number }) =>
      apiRequest<Payment>(`/payments/${id}/capture`, { method: 'POST', body: { amount } }),
    onSuccess: (_d, vars) => invalidatePayments(qc, vars.id),
  });
}
