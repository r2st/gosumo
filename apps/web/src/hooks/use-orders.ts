'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPaginated, apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { Order } from '@/lib/types';
import type { OrderDetail, OrderListQuery, OrderStats } from '@/lib/commerce-types';

const ORDERS_KEY = ['orders'];

export function useOrders(filters: OrderListQuery = {}) {
  return useQuery({
    queryKey: [...ORDERS_KEY, filters],
    queryFn: ({ signal }) => apiPaginated<Order>(`/orders${toQuery({ ...filters })}`, { signal }),
  });
}

export function useOrder(id: string | null) {
  return useQuery({
    queryKey: ['order', id],
    queryFn: () => apiRequest<OrderDetail>(`/orders/${id}`),
    enabled: !!id,
  });
}

export function useOrderStats(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['orders', 'stats', params],
    queryFn: () => apiRequest<OrderStats>(`/orders/stats${toQuery({ ...params })}`),
  });
}

function invalidateOrder(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ORDERS_KEY });
  qc.invalidateQueries({ queryKey: ['order', id] });
}

export function useConfirmOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sendConfirmation = true }: { id: string; sendConfirmation?: boolean }) =>
      apiRequest<Order>(`/orders/${id}/confirm`, { method: 'POST', body: { sendConfirmation } }),
    onSuccess: (_d, vars) => invalidateOrder(qc, vars.id),
  });
}

export function useFulfillOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notifyClient = true }: { id: string; notifyClient?: boolean }) =>
      apiRequest<{ order: Order }>(`/orders/${id}/fulfill`, { method: 'POST', body: { notifyClient } }),
    onSuccess: (_d, vars) => invalidateOrder(qc, vars.id),
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, refundPayment, notifyClient = true }: { id: string; reason: string; refundPayment?: boolean; notifyClient?: boolean }) =>
      apiRequest<Order>(`/orders/${id}/cancel`, { method: 'POST', body: { reason, refundPayment, notifyClient } }),
    onSuccess: (_d, vars) => invalidateOrder(qc, vars.id),
  });
}

/**
 * Advance an order to an arbitrary lifecycle status (e.g. PROCESSING → SHIPPED →
 * DELIVERED). The documented action endpoints cover confirm/fulfill/cancel; this
 * conventional status transition covers the remaining forward moves.
 */
export function useUpdateOrderStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, trackingNumber }: { id: string; status: Order['status']; trackingNumber?: string }) =>
      apiRequest<Order>(`/orders/${id}/status`, { method: 'POST', body: { status, trackingNumber } }),
    onSuccess: (_d, vars) => invalidateOrder(qc, vars.id),
  });
}
