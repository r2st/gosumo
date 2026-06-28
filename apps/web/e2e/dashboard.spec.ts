import { test, expect } from './fixtures/auth.fixture';
import { DashboardPage } from './pages/dashboard.page';
import { SidebarNav } from './pages/sidebar.page';

test.describe('Dashboard', () => {
  let dashboard: DashboardPage;

  test.beforeEach(async ({ page }) => {
    dashboard = new DashboardPage(page);
    await dashboard.goto();
    await dashboard.expectLoaded();
  });

  test('should load the dashboard with heading', async () => {
    await expect(dashboard.heading).toBeVisible();
  });

  test('should display all KPI cards', async () => {
    await dashboard.expectKpiCardsVisible();
  });

  test('should display conversation statistics', async ({ page }) => {
    // Check that KPI cards show meaningful data
    await expect(dashboard.kpiCard('Conversations')).toBeVisible();
    await expect(dashboard.kpiCard('Avg response time')).toBeVisible();
    await expect(dashboard.kpiCard('Resolution rate')).toBeVisible();
  });

  test('should display chart sections', async () => {
    await dashboard.expectChartsVisible();
  });

  test('should display recent activity section', async () => {
    await expect(dashboard.recentActivitySection).toBeVisible();
  });

  test('should have a "View all" link to conversations', async ({ page }) => {
    await expect(dashboard.viewAllLink).toBeVisible();
    await expect(dashboard.viewAllLink).toHaveAttribute('href', /\/conversations/);
  });

  test('should navigate to conversations when clicking "View all"', async ({ page }) => {
    await dashboard.viewAllLink.click();
    await page.waitForURL('**/conversations');
    await expect(page).toHaveURL(/\/conversations/);
  });

  test('should show sidebar navigation', async ({ page }) => {
    const sidebar = new SidebarNav(page);
    await sidebar.expectVisible();
  });
});
