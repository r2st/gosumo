import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The page pulls catalog data through these hooks; mock them so we can feed in
// a malformed item (missing imageUrls/variants) that previously crashed the page
// with "Cannot read properties of undefined (reading '0')".
vi.mock('@/hooks/use-catalog', () => ({
  useCatalogItems: () => ({
    data: {
      data: [
        {
          id: 'item-1',
          name: 'Comprehensive Health Check',
          type: 'SERVICE',
          basePrice: 399900,
          isActive: true,
          // intentionally omit imageUrls and variants
        },
      ],
      pagination: { total: 1 },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useCategories: () => ({ data: { categories: [] } }),
}));

// Modals are not under test; render nothing for them.
vi.mock('@/components/catalog/product-form-modal', () => ({
  ProductFormModal: () => null,
}));
vi.mock('@/components/catalog/category-manager', () => ({
  CategoryManager: () => null,
}));

// The page's action bar is role-gated (see @/hooks/use-permissions), so the
// tests need a session. Without a provider the hook correctly reports
// read-only and every write control disappears — which is its own test, in
// src/__tests__/viewer-gating.test.tsx.
const authValue = {
  status: 'authenticated' as const,
  user: {
    id: 'u1',
    email: 'staff@acme.in',
    name: 'Staff',
    role: 'OWNER' as const,
    businessId: 'biz-1',
    twoFactorEnabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  business: null,
};
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue,
  useOptionalAuth: () => authValue,
}));

import CatalogPage from './page';

describe('CatalogPage', () => {
  it('renders an item with no imageUrls/variants without crashing', () => {
    expect(() => render(<CatalogPage />)).not.toThrow();
    expect(screen.getByText('Comprehensive Health Check')).toBeInTheDocument();
  });
});
