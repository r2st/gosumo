'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { AppNotification } from '@/lib/feature-types';

const KEY = ['notifications'];

export interface NotificationFeed {
  data: AppNotification[];
  unreadCount: number;
}

export function useNotifications() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<NotificationFeed> => {
      // Deliberately not `apiPaginated`: this endpoint carries an extra
      // `unreadCount` alongside the page, and only `data` is read here — so
      // the flat backend shape is described as-is rather than claimed to be
      // a `PaginatedResponse` whose `pagination` would not exist at runtime.
      const res = await apiRequest<{ data: AppNotification[]; unreadCount?: number }>(
        `/notifications${toQuery({ limit: 20 })}`,
      );
      const unreadCount = res.unreadCount ?? res.data.filter((n) => !n.read).length;
      return { data: res.data, unreadCount };
    },
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      apiRequest<AppNotification>(`/notifications/${id}`, { method: 'PATCH', body: { read } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>('/notifications/read-all', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
