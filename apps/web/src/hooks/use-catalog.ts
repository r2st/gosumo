'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';
import type { CatalogItem, PaginatedResponse } from '@/lib/types';
import type {
  CatalogItemListQuery,
  CategoriesResponse,
  CatalogCategory,
  CreateCatalogItemRequest,
  CreateCategoryRequest,
} from '@/lib/commerce-types';

const ITEMS_KEY = ['catalog', 'items'];
const CATEGORIES_KEY = ['catalog', 'categories'];

// ── Items ─────────────────────────────────────────────────────────────────────

export function useCatalogItems(filters: CatalogItemListQuery = {}) {
  return useQuery({
    queryKey: [...ITEMS_KEY, filters],
    queryFn: ({ signal }) =>
      apiRequest<PaginatedResponse<CatalogItem>>(`/catalog/items${toQuery({ ...filters })}`, { signal }),
  });
}

export function useCatalogItem(id: string | null) {
  return useQuery({
    queryKey: ['catalog', 'item', id],
    queryFn: () => apiRequest<CatalogItem>(`/catalog/items/${id}`),
    enabled: !!id,
  });
}

export function useCreateCatalogItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCatalogItemRequest) =>
      apiRequest<CatalogItem>('/catalog/items', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ITEMS_KEY }),
  });
}

export function useUpdateCatalogItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateCatalogItemRequest> }) =>
      apiRequest<CatalogItem>(`/catalog/items/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ITEMS_KEY });
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

export function useDeleteCatalogItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/catalog/items/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ITEMS_KEY });
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

/** Toggle real-time availability for a single item via the bulk endpoint. */
export function useSetAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      apiRequest<{ updated: number }>('/catalog/items/bulk-availability', {
        method: 'PATCH',
        body: { updates: [{ itemId: id, isAvailable }] },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ITEMS_KEY }),
  });
}

// ── Categories ─────────────────────────────────────────────────────────────────

export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: () => apiRequest<CategoriesResponse>('/catalog/categories'),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCategoryRequest) =>
      apiRequest<CatalogCategory>('/catalog/categories', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateCategoryRequest> }) =>
      apiRequest<CatalogCategory>(`/catalog/categories/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/catalog/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}
