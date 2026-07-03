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

import CatalogPage from './page';

describe('CatalogPage', () => {
  it('renders an item with no imageUrls/variants without crashing', () => {
    expect(() => render(<CatalogPage />)).not.toThrow();
    expect(screen.getByText('Comprehensive Health Check')).toBeInTheDocument();
  });
});
