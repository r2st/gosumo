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
} from '@/lib/realty-types';

const LEADS_KEY = ['realty', 'leads'];
const BOARD_KEY = ['realty', 'leads', 'board'];
const PROJECTS_KEY = ['realty', 'projects'];

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
