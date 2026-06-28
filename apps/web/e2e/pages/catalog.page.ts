import { type Page, type Locator, expect } from '@playwright/test';

export class CatalogPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchInput: Locator;
  readonly addItemButton: Locator;
  readonly categoriesButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Catalog', level: 1 });
    this.searchInput = page.getByPlaceholder('Search catalog...');
    this.addItemButton = page.getByRole('button', { name: 'Add item' });
    this.categoriesButton = page.getByRole('button', { name: 'Categories' });
  }

  async goto() {
    await this.page.goto('/catalog');
  }

  filterButton(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  async clickFilter(name: string) {
    await this.filterButton(name).click();
  }

  async search(query: string) {
    await this.searchInput.fill(query);
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible();
  }

  async expectItems() {
    // Wait for catalog items to appear (cards with item names)
    await expect(this.page.locator('[class*="card"]').first()).toBeVisible({ timeout: 10_000 });
  }

  async expectEmptyState() {
    await expect(this.page.getByText('No catalog items')).toBeVisible();
  }
}
