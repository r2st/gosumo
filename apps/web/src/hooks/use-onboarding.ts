'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import type {
  OnboardingChatMessage,
  OnboardingChatResponse,
  OnboardingProgress,
  OnboardingStatus,
  OnboardingStepId,
  UpdateOnboardingStepInput,
} from '@/lib/onboarding-types';

const PROGRESS_KEY = ['onboarding', 'progress'];
const STATUS_KEY = ['onboarding', 'status'];

/** Lightweight status check — used on login to decide whether to show the wizard. */
export function useOnboardingStatus(enabled = true) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiRequest<OnboardingStatus>('/onboarding/status'),
    enabled,
    staleTime: 60_000,
  });
}

/** Full per-step progress — used by the wizard itself. */
export function useOnboardingProgress(enabled = true) {
  return useQuery({
    queryKey: PROGRESS_KEY,
    queryFn: () => apiRequest<OnboardingProgress>('/onboarding/progress'),
    enabled,
  });
}

export function useUpdateOnboardingStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOnboardingStepInput) =>
      apiRequest<OnboardingProgress>('/onboarding/progress', { method: 'PUT', body }),
    onSuccess: (data) => {
      qc.setQueryData(PROGRESS_KEY, data);
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<OnboardingProgress>('/onboarding/complete', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      qc.setQueryData(PROGRESS_KEY, data);
      qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}

export function useOnboardingChat() {
  return useMutation({
    mutationFn: (body: { message: string; step?: OnboardingStepId; history?: OnboardingChatMessage[] }) =>
      apiRequest<OnboardingChatResponse>('/onboarding/chat', { method: 'POST', body }),
  });
}
