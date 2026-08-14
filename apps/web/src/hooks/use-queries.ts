'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type ClientFilters,
  type ConversationFilters,
  type HitlFilters,
} from '@/lib/api-client';
import type {
  BookingStatus,
  HitlPriority,
  OrderStatus,
  PaymentStatus,
} from '@/lib/types';

// ── Dashboard / analytics ─────────────────────────────────────────────────────

export function useDashboardMetrics(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['analytics', 'dashboard', params],
    queryFn: () => api.analytics.dashboard(params),
  });
}

export function useConversationReport(params: { from?: string; to?: string; granularity?: string } = {}) {
  return useQuery({
    queryKey: ['analytics', 'conversations', params],
    queryFn: () => api.analytics.conversations(params),
  });
}

export function useRevenueReport(params: { from?: string; to?: string; granularity?: string } = {}) {
  return useQuery({
    queryKey: ['analytics', 'revenue', params],
    queryFn: () => api.analytics.revenue(params),
  });
}

// ── Conversations ─────────────────────────────────────────────────────────────

export function useConversations(filters: ConversationFilters = {}) {
  return useQuery({
    queryKey: ['conversations', filters],
    queryFn: ({ signal }) => api.conversations.list(filters, signal),
  });
}

export function useConversation(id: string | null, include?: string[]) {
  return useQuery({
    queryKey: ['conversation', id, include],
    queryFn: () => api.conversations.get(id as string, include),
    enabled: !!id,
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.conversations.messages(conversationId as string),
    enabled: !!conversationId,
    refetchInterval: 15_000,
  });
}

/**
 * Clear a conversation's unread badge once an operator has it open.
 *
 * Fire-and-forget on purpose: a VIEWER is read-only across the API and gets a
 * 403 here, and a failed mark-read is not worth an error state over a thread
 * the operator is already reading. The list is only refetched when the call
 * actually cleared something, so an already-read thread costs no extra request.
 */
export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.conversations.markRead(id),
    onSuccess: (data) => {
      if (data?.cleared) qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: () => {},
  });
}

export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.conversations.sendMessage(conversationId, text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useResolveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution?: string }) =>
      api.conversations.resolve(id, resolution),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', vars.id] });
    },
  });
}

export function useEscalateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, priority }: { id: string; reason: string; priority?: HitlPriority }) =>
      api.conversations.escalate(id, reason, priority),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', vars.id] });
      qc.invalidateQueries({ queryKey: ['hitl'] });
    },
  });
}

export function useUpdateConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      status?: import('@/lib/types').ConversationStatus;
      assignedTo?: string | null;
      tags?: string[];
    }) => api.conversations.update(id, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', vars.id] });
    },
  });
}

// ── HITL tasks ────────────────────────────────────────────────────────────────

export function useHitlTasks(filters: HitlFilters = {}) {
  return useQuery({
    queryKey: ['hitl', 'tasks', filters],
    queryFn: ({ signal }) => api.hitl.list(filters, signal),
    refetchInterval: 20_000,
  });
}

export function useApproveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, editedResponse }: { id: string; editedResponse?: string }) =>
      api.hitl.approve(id, editedResponse),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hitl'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

export function useRejectTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.hitl.reject(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hitl'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// ── Clients ─────────────────────────────────────────────────────────────────

export function useClients(filters: ClientFilters = {}) {
  return useQuery({
    queryKey: ['clients', filters],
    queryFn: ({ signal }) => api.clients.list(filters, signal),
  });
}

export function useClient(id: string | null, include?: string[]) {
  return useQuery({
    queryKey: ['client', id, include],
    queryFn: () => api.clients.get(id as string, include),
    enabled: !!id,
  });
}

export function useClientTimeline(id: string | null) {
  return useQuery({
    queryKey: ['client', id, 'timeline'],
    queryFn: () => api.clients.timeline(id as string),
    enabled: !!id,
  });
}

export function useClientSegments() {
  return useQuery({ queryKey: ['clients', 'segments'], queryFn: () => api.clients.segments() });
}

// ── Commerce ────────────────────────────────────────────────────────────────

export function useCatalogItems(filters: { q?: string; type?: string; page?: number } = {}) {
  return useQuery({
    queryKey: ['catalog', filters],
    queryFn: ({ signal }) => api.catalog.items(filters, signal),
  });
}

export function useOrders(filters: { status?: OrderStatus; q?: string; page?: number } = {}) {
  return useQuery({
    queryKey: ['orders', filters],
    queryFn: ({ signal }) => api.orders.list(filters, signal),
  });
}

export function useBookings(
  filters: { status?: BookingStatus; from?: string; to?: string; include?: string; page?: number; limit?: number } = {},
) {
  return useQuery({
    queryKey: ['bookings', filters],
    queryFn: ({ signal }) => api.bookings.list(filters, signal),
  });
}

export function usePayments(filters: { status?: PaymentStatus; method?: string; page?: number } = {}) {
  return useQuery({
    queryKey: ['payments', filters],
    queryFn: ({ signal }) => api.payments.list(filters, signal),
  });
}
