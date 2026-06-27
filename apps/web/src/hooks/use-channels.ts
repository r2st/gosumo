'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

// Test a channel connection
export function useTestChannel() {
  return useMutation({
    mutationFn: (channelId: string) =>
      apiRequest<{ success: boolean; message: string; latencyMs: number }>(
        `/channels/${channelId}/test`,
        { method: 'POST' }
      ),
  });
}

// Get web chat embed snippet
export function useWebChatEmbed() {
  return useMutation({
    mutationFn: (channelId: string) =>
      apiRequest<{ snippet: string; widgetId: string; config: Record<string, unknown> }>(
        `/channels/webchat/embed/${channelId}`
      ),
  });
}

// Toggle channel enabled/disabled
export function useToggleChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, enabled }: { channelId: string; enabled: boolean }) =>
      apiRequest(`/channels/${channelId}/toggle`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}
