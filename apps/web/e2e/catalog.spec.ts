import { test, expect } from './fixtures/auth.fixture';
import { CatalogPage } from './pages/catalog.page';

test.describe('Catalog', () => {
  let catalog: CatalogPage;

  test.beforeEach(async ({ page }) => {
    catalog = new CatalogPage(page);
    await catalog.goto();
    await catalog.expectLoaded();
  });

  test('should load the catalog page', async () => {
    await expect(catalog.heading).toBeVisible();
  });

  test('should display the search input', async () => {
    await expect(catalog.searchInput).toBeVisible();
  });

  test('should display the Add item button', async () => {
    await expect(catalog.addItemButton).toBeVisible();
  });

  test('should display type filter buttons', async ({ page }) => {
    const filterNames = ['All', 'Products', 'Services', 'Packages', 'Digital'];
    for (const name of filterNames) {
      await expect(catalog.filterButton(name)).toBeVisible();
    }
  });

  test('should display catalog items', async () => {
    test.slow();
    await catalog.expectItems();
  });

  test('should filter items by type when clicking filter buttons', async ({ page }) => {
    test.slow();
    // Click Products filter
    await catalog.clickFilter('Products');
    // Page should still be on catalog and showing filtered results
    await expect(page).toHaveURL(/\/catalog/);

    // Click Services filter
    await catalog.clickFilter('Services');
    await expect(page).toHaveURL(/\/catalog/);

    // Click All to reset
    await catalog.clickFilter('All');
    await expect(page).toHaveURL(/\/catalog/);
  });

  test('should allow searching the catalog', async () => {
    await catalog.search('test');
    await expect(catalog.searchInput).toHaveValue('test');
  });
});
