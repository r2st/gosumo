'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { ConversationReport, RevenueReport } from '@/lib/types';
import type {
  AgentPerformance,
  AutonomyReport,
  ClientReport,
  DateRangeParams,
  FulfillmentBreakdown,
} from '@/lib/feature-types';

/** Conversation report including the agent-performance leaderboard. */
export type ConversationReportFull = ConversationReport & { agentPerformance?: AgentPerformance[] };
/** Revenue report including the fulfillment mix. */
export type RevenueReportFull = RevenueReport & { fulfillmentBreakdown?: FulfillmentBreakdown };

export function useAutonomyReport(params: DateRangeParams) {
  return useQuery({
    queryKey: ['analytics', 'autonomy', params],
    queryFn: () => apiRequest<AutonomyReport>(`/analytics/autonomy${toQuery({ ...params })}`),
  });
}

export function useClientReport(params: DateRangeParams) {
  return useQuery({
    queryKey: ['analytics', 'clients', params],
    queryFn: () => apiRequest<ClientReport>(`/analytics/clients${toQuery({ ...params })}`),
  });
}

export function useConversationReportFull(params: DateRangeParams) {
  return useQuery({
    queryKey: ['analytics', 'conversations-full', params],
    queryFn: () => apiRequest<ConversationReportFull>(`/analytics/conversations${toQuery({ ...params })}`),
  });
}

export function useRevenueReportFull(params: DateRangeParams) {
  return useQuery({
    queryKey: ['analytics', 'revenue-full', params],
    queryFn: () => apiRequest<RevenueReportFull>(`/analytics/revenue${toQuery({ ...params })}`),
  });
}

export interface ExportReportRequest {
  reportType: 'CONVERSATIONS' | 'REVENUE' | 'AI_AUTONOMY' | 'CLIENTS' | 'CAMPAIGNS';
  format: 'CSV' | 'PDF';
  from: string;
  to: string;
}

export function useExportReport() {
  return useMutation({
    mutationFn: (body: ExportReportRequest) =>
      apiRequest<{ jobId: string; estimatedSeconds: number }>('/analytics/reports/export', {
        method: 'POST',
        body,
      }),
  });
}
