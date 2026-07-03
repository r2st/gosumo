'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { PaginatedResponse } from '@/lib/types';
import type {
  Lead,
  LeadBoardColumn,
  LeadStage,
  RealtyProject,
  UnitMatch,
  MessageTemplate,
  Cadence,
  CadenceTrigger,
  Approval,
  ApprovalStatus,
  BrokerSettings,
  AlertsResponse,
  MorningBriefing,
  BrokerConsoleMetrics,
  SiteVisit,
  SiteVisitStatus,
  SiteVisitOutcome,
  SiteVisitListResponse,
  BookVisitInput,
  CsvImportRow,
  CsvImportResult,
} from '@/lib/realty-types';

const LEADS_KEY = ['realty', 'leads'];
const BOARD_KEY = ['realty', 'leads', 'board'];
const PROJECTS_KEY = ['realty', 'projects'];
const TEMPLATES_KEY = ['realty', 'templates'];
const CADENCES_KEY = ['realty', 'cadences'];
const APPROVALS_KEY = ['realty', 'approvals'];
const ALERTS_KEY = ['realty', 'alerts'];
const SETTINGS_KEY = ['realty', 'broker', 'settings'];
const CONSOLE_KEY = ['realty', 'broker', 'console'];
const BRIEFING_KEY = ['realty', 'broker', 'briefing'];
const VISITS_KEY = ['realty', 'site-visits'];

export interface LeadListFilters {
  stage?: LeadStage;
  temperature?: string;
  source?: string;
  search?: string;
  page?: number;
  limit?: number;
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export function useLeads(filters: LeadListFilters = {}) {
  return useQuery({
    queryKey: [...LEADS_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<PaginatedResponse<Lead>>(`/realty/leads${toQuery({ ...filters })}`, { signal }),
  });
}

export function useLeadBoard() {
  return useQuery({
    queryKey: BOARD_KEY,
    queryFn: ({ signal }) => apiRequest<LeadBoardColumn[]>('/realty/leads/board', { signal }),
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['realty', 'lead', id],
    queryFn: () => apiRequest<Lead>(`/realty/leads/${id}`),
    enabled: !!id,
  });
}

export function useTransitionStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: LeadStage }) =>
      apiRequest<Lead>(`/realty/leads/${id}/stage`, { method: 'POST', body: { stage } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LEADS_KEY });
      qc.invalidateQueries({ queryKey: BOARD_KEY });
    },
  });
}

export function useMatchForLead() {
  return useMutation({
    mutationFn: ({ id, limit }: { id: string; limit?: number }) =>
      apiRequest<UnitMatch[]>(`/realty/leads/${id}/match${toQuery({ limit })}`, { method: 'POST', body: {} }),
  });
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export function useProjects(filters: { locality?: string; status?: string } = {}) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<RealtyProject[]>(`/realty/projects${toQuery({ ...filters })}`, { signal }),
  });
}

// ── Cadence: templates ──────────────────────────────────────────────────────────

export function useTemplates(filters: { category?: string; approvalStatus?: string } = {}) {
  return useQuery({
    queryKey: [...TEMPLATES_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<MessageTemplate[]>(`/realty/cadence/templates${toQuery({ ...filters })}`, { signal }),
  });
}

export function useSetTemplateApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approvalStatus }: { id: string; approvalStatus: string }) =>
      apiRequest<MessageTemplate>(`/realty/cadence/templates/${id}/approval`, {
        method: 'POST',
        body: { approvalStatus },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  });
}

// ── Cadence: cadences ───────────────────────────────────────────────────────────

export function useCadences(filters: { trigger?: CadenceTrigger } = {}) {
  return useQuery({
    queryKey: [...CADENCES_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<Cadence[]>(`/realty/cadence/cadences${toQuery({ ...filters })}`, { signal }),
  });
}

export function useUpdateCadence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiRequest<Cadence>(`/realty/cadence/cadences/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CADENCES_KEY }),
  });
}

export function useSeedCadences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<{ templates: number; cadences: number }>(`/realty/cadence/seed`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      qc.invalidateQueries({ queryKey: CADENCES_KEY });
    },
  });
}

// ── Broker: approval queue ──────────────────────────────────────────────────────

export function useApprovals(filters: { status?: ApprovalStatus } = {}) {
  return useQuery({
    queryKey: [...APPROVALS_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<Approval[]>(`/realty/broker/approvals${toQuery({ ...filters })}`, { signal }),
  });
}

export function useResolveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      status,
      editedText,
      reason,
    }: {
      id: string;
      status: ApprovalStatus;
      editedText?: string;
      reason?: string;
    }) =>
      apiRequest<Approval>(`/realty/broker/approvals/${id}/resolve`, {
        method: 'POST',
        body: { status, editedText, reason },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: APPROVALS_KEY });
      qc.invalidateQueries({ queryKey: CONSOLE_KEY });
    },
  });
}

// ── Broker: settings, alerts, console, briefing ─────────────────────────────────

export function useBrokerSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => apiRequest<BrokerSettings>('/realty/broker/settings', { signal }),
  });
}

export function useUpdateBrokerSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<BrokerSettings>) =>
      apiRequest<BrokerSettings>('/realty/broker/settings', { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: CONSOLE_KEY });
    },
  });
}

export function useBrokerAlerts(unreadOnly = false) {
  return useQuery({
    queryKey: [...ALERTS_KEY, { unreadOnly }],
    queryFn: ({ signal }) =>
      apiRequest<AlertsResponse>(`/realty/broker/alerts${toQuery({ unreadOnly })}`, { signal }),
    refetchInterval: 60_000,
  });
}

export function useMarkAlertRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/realty/broker/alerts/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ALERTS_KEY }),
  });
}

export function useMarkAllAlertsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest(`/realty/broker/alerts/read-all`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ALERTS_KEY }),
  });
}

export function useBrokerConsole() {
  return useQuery({
    queryKey: CONSOLE_KEY,
    queryFn: ({ signal }) => apiRequest<BrokerConsoleMetrics>('/realty/broker/console', { signal }),
  });
}

export function useMorningBriefing() {
  return useQuery({
    queryKey: BRIEFING_KEY,
    queryFn: ({ signal }) => apiRequest<MorningBriefing>('/realty/broker/briefing', { signal }),
  });
}

// ── Site visits (Phase 3) ───────────────────────────────────────────────────────

export interface SiteVisitFilters {
  status?: SiteVisitStatus;
  leadId?: string;
  from?: string;
  to?: string;
  upcoming?: boolean;
  page?: number;
  limit?: number;
}

export function useSiteVisits(filters: SiteVisitFilters = {}) {
  return useQuery({
    queryKey: [...VISITS_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<SiteVisitListResponse>(`/realty/site-visits${toQuery({ ...filters })}`, { signal }),
  });
}

export function useSiteVisit(id: string | null) {
  return useQuery({
    queryKey: ['realty', 'site-visit', id],
    queryFn: () => apiRequest<SiteVisit>(`/realty/site-visits/${id}`),
    enabled: !!id,
  });
}

/** A single lead's visit history — powers the lead detail drawer. */
export function useLeadVisits(leadId: string | null) {
  return useQuery({
    queryKey: [...VISITS_KEY, 'lead', leadId],
    queryFn: () =>
      apiRequest<SiteVisitListResponse>(`/realty/site-visits${toQuery({ leadId, limit: 50 })}`),
    enabled: !!leadId,
  });
}

function invalidateVisits(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: VISITS_KEY });
  qc.invalidateQueries({ queryKey: LEADS_KEY });
  qc.invalidateQueries({ queryKey: BOARD_KEY });
}

export function useBookVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BookVisitInput) =>
      apiRequest<SiteVisit>('/realty/site-visits', { method: 'POST', body }),
    onSuccess: () => invalidateVisits(qc),
  });
}

export function useConfirmVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<SiteVisit>(`/realty/site-visits/${id}/confirm`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateVisits(qc),
  });
}

export function useRescheduleVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newScheduledAt, durationMinutes }: { id: string; newScheduledAt: string; durationMinutes?: number }) =>
      apiRequest<SiteVisit>(`/realty/site-visits/${id}/reschedule`, {
        method: 'POST',
        body: { newScheduledAt, durationMinutes },
      }),
    onSuccess: () => invalidateVisits(qc),
  });
}

export function useCancelVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiRequest<SiteVisit>(`/realty/site-visits/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => invalidateVisits(qc),
  });
}

export function useCompleteVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome, feedback }: { id: string; outcome: SiteVisitOutcome; feedback?: string }) =>
      apiRequest<SiteVisit>(`/realty/site-visits/${id}/complete`, {
        method: 'POST',
        body: { outcome, feedback },
      }),
    onSuccess: () => invalidateVisits(qc),
  });
}

export function useMarkNoShow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<SiteVisit>(`/realty/site-visits/${id}/no-show`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateVisits(qc),
  });
}

// ── Ingestion: CSV import (Phase 4) ─────────────────────────────────────────────

export function useImportCsv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: CsvImportRow[]) =>
      apiRequest<CsvImportResult>('/realty/ingestion/csv', { method: 'POST', body: { rows } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LEADS_KEY });
      qc.invalidateQueries({ queryKey: BOARD_KEY });
    },
  });
}
