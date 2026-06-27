'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { Booking, PaginatedResponse } from '@/lib/types';
import type { BusinessSettings } from '@/lib/feature-types';
import type {
  BookingListQuery,
  CalendarEvent,
  CancelBookingRequest,
  CreateBookingRequest,
  SlotsResponse,
  StaffMember,
  UpdateBookingRequest,
} from '@/lib/commerce-types';

const BOOKINGS_KEY = ['bookings'];
const SETTINGS_KEY = ['business', 'settings'];

export function useBookings(filters: BookingListQuery = {}) {
  return useQuery({
    queryKey: [...BOOKINGS_KEY, filters],
    queryFn: ({ signal }) => apiRequest<PaginatedResponse<Booking>>(`/bookings${toQuery({ ...filters })}`, { signal }),
  });
}

export function useBooking(id: string | null) {
  return useQuery({
    queryKey: ['booking', id],
    queryFn: () => apiRequest<Booking>(`/bookings/${id}`),
    enabled: !!id,
  });
}

export function useCalendar(range: { from: string; to: string; staffMemberId?: string }) {
  return useQuery({
    queryKey: ['bookings', 'calendar', range],
    queryFn: ({ signal }) =>
      apiRequest<{ events: CalendarEvent[] }>(`/bookings/calendar${toQuery({ ...range })}`, { signal }),
  });
}

export function useSlots(
  query: { catalogItemId?: string; variantId?: string; staffMemberId?: string; from: string; to: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ['bookings', 'slots', query],
    queryFn: () => apiRequest<SlotsResponse>(`/bookings/slots${toQuery({ ...query })}`),
    enabled: enabled && !!query.catalogItemId,
  });
}

export function useStaff() {
  return useQuery({
    queryKey: ['bookings', 'staff'],
    queryFn: () => apiRequest<{ staff: StaffMember[] }>('/bookings/staff'),
  });
}

function invalidateBookings(qc: ReturnType<typeof useQueryClient>, id?: string) {
  qc.invalidateQueries({ queryKey: BOOKINGS_KEY });
  if (id) qc.invalidateQueries({ queryKey: ['booking', id] });
}

export function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBookingRequest) => apiRequest<Booking>('/bookings', { method: 'POST', body }),
    onSuccess: () => invalidateBookings(qc),
  });
}

/** Reschedule (startTime) or update status/staff/notes. */
export function useUpdateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateBookingRequest }) =>
      apiRequest<Booking>(`/bookings/${id}`, { method: 'PATCH', body }),
    onSuccess: (_d, vars) => invalidateBookings(qc, vars.id),
  });
}

export function useCancelBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & CancelBookingRequest) =>
      apiRequest<Booking>(`/bookings/${id}/cancel`, { method: 'POST', body }),
    onSuccess: (_d, vars) => invalidateBookings(qc, vars.id),
  });
}

export function useCompleteBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, requestReview }: { id: string; requestReview?: boolean }) =>
      apiRequest<Booking>(`/bookings/${id}/complete`, { method: 'POST', body: { requestReview } }),
    onSuccess: (_d, vars) => invalidateBookings(qc, vars.id),
  });
}

// ── Availability settings ──────────────────────────────────────────────────────
// Booking availability is governed by the business office hours + default slot
// duration. These read/write the same /business/settings resource as Settings.

export function useBusinessSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiRequest<BusinessSettings>('/business/settings'),
  });
}

export function useUpdateBusinessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<BusinessSettings>) =>
      apiRequest<BusinessSettings>('/business/settings', { method: 'PATCH', body }),
    onSuccess: (data) => qc.setQueryData(SETTINGS_KEY, data),
  });
}
