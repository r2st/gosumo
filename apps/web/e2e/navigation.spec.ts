import { test, expect } from './fixtures/auth.fixture';
import { SidebarNav } from './pages/sidebar.page';

test.describe('Navigation', () => {
  let sidebar: SidebarNav;

  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    sidebar = new SidebarNav(page);
  });

  test.describe('Sidebar Navigation Links', () => {
    const pages = [
      { name: 'Dashboard' as const, heading: 'Dashboard', path: '/dashboard' },
      { name: 'Conversations' as const, heading: 'Conversations', path: '/conversations' },
      { name: 'Clients' as const, heading: 'Clients', path: '/clients' },
      { name: 'Catalog' as const, heading: 'Catalog', path: '/catalog' },
      { name: 'Orders' as const, heading: 'Orders', path: '/orders' },
      { name: 'Bookings' as const, heading: 'Bookings', path: '/bookings' },
      { name: 'Payments' as const, heading: 'Payments', path: '/payments' },
      { name: 'Analytics' as const, heading: 'Analytics', path: '/analytics' },
      { name: 'Settings' as const, heading: 'Settings', path: '/settings' },
    ];

    for (const { name, heading, path } of pages) {
      test(`should navigate to ${name} page`, async ({ page }) => {
        await sidebar.navigateTo(name);
        await expect(page).toHaveURL(new RegExp(path));
        await expect(
          page.getByRole('heading', { name: heading, level: 1 })
        ).toBeVisible({ timeout: 10_000 });
      });
    }
  });

  test('should highlight the active page in sidebar', async ({ page }) => {
    await sidebar.navigateTo('Catalog');
    await sidebar.expectActivePage('Catalog');
  });

  test('should support browser back navigation', async ({ page }) => {
    // Navigate from Dashboard to Conversations
    await sidebar.navigateTo('Conversations');
    await expect(page).toHaveURL(/\/conversations/);

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('should support browser forward navigation', async ({ page }) => {
    // Navigate to Conversations then back
    await sidebar.navigateTo('Conversations');
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard/);

    // Go forward
    await page.goForward();
    await expect(page).toHaveURL(/\/conversations/);
  });

  test('should load pages via direct URL access', async ({ page }) => {
    // Navigate directly to catalog page
    await page.goto('/catalog');
    await expect(page.getByRole('heading', { name: 'Catalog', level: 1 })).toBeVisible();
  });
});
