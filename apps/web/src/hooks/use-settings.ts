'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPaginated, apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { BusinessProfile } from '@/lib/types';
import type {
  BusinessSettings,
  CalendarIntegration,
  Channel,
  ConfidenceThresholds,
  InviteTeamMemberRequest,
  Role,
  SubscriptionInfo,
  SubscriptionPlan,
  TeamMember,
} from '@/lib/feature-types';

// ── Business profile & settings ─────────────────────────────────────────────
export function useBusinessProfile() {
  return useQuery({
    queryKey: ['business', 'me'],
    queryFn: () => apiRequest<BusinessProfile>('/business/me'),
  });
}

export function useUpdateBusinessProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<BusinessProfile>) =>
      apiRequest<BusinessProfile>('/business/me', { method: 'PATCH', body }),
    onSuccess: (data) => {
      qc.setQueryData(['business', 'me'], data);
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useBusinessSettings() {
  return useQuery({
    queryKey: ['business', 'settings'],
    queryFn: () => apiRequest<BusinessSettings>('/business/settings'),
  });
}

export function useUpdateBusinessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<BusinessSettings>) =>
      apiRequest<BusinessSettings>('/business/settings', { method: 'PATCH', body }),
    onSuccess: (data) => qc.setQueryData(['business', 'settings'], data),
  });
}

// ── Team ────────────────────────────────────────────────────────────────────
export function useTeam() {
  return useQuery({
    queryKey: ['team'],
    queryFn: () => apiPaginated<TeamMember>(`/auth/team${toQuery({ limit: 100 })}`),
  });
}

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteTeamMemberRequest) => apiRequest('/auth/team/invite', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      apiRequest<TeamMember>(`/auth/team/${memberId}/role`, { method: 'PATCH', body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => apiRequest<void>(`/auth/team/${memberId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

// ── Channels ────────────────────────────────────────────────────────────────
export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: () => apiPaginated<Channel>(`/channels${toQuery({ limit: 100 })}`),
  });
}

export function useConnectChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      apiRequest(path, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useDisconnectChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => apiRequest<void>(`/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

// ── AI confidence thresholds ────────────────────────────────────────────────
export function useConfidenceThresholds() {
  return useQuery({
    queryKey: ['ai', 'thresholds'],
    queryFn: () => apiRequest<ConfidenceThresholds>('/ai/confidence/thresholds'),
  });
}

export function useUpdateThresholds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ConfidenceThresholds>) =>
      apiRequest<ConfidenceThresholds>('/ai/confidence/thresholds', { method: 'PATCH', body }),
    onSuccess: (data) => qc.setQueryData(['ai', 'thresholds'], data),
  });
}

// ── Subscription / billing ──────────────────────────────────────────────────
export function useSubscription() {
  return useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => apiRequest<SubscriptionInfo>('/business/subscription'),
  });
}

export function useUpgradePlan() {
  return useMutation({
    mutationFn: (plan: SubscriptionPlan) =>
      apiRequest<{ checkoutUrl?: string }>('/business/subscription/upgrade', { method: 'POST', body: { plan } }),
  });
}

// ── Google Calendar integration ─────────────────────────────────────────────
export function useCalendarIntegration() {
  return useQuery({
    queryKey: ['integrations', 'google-calendar'],
    queryFn: () => apiRequest<CalendarIntegration>('/integrations/google-calendar'),
  });
}

export function useConnectCalendar() {
  return useMutation({
    mutationFn: () => apiRequest<{ authUrl: string }>('/integrations/google-calendar/connect', { method: 'POST' }),
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>('/integrations/google-calendar', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', 'google-calendar'] }),
  });
}

export function useSyncCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>('/bookings/calendar/sync', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', 'google-calendar'] }),
  });
}
