import { type Page, type Locator, expect } from '@playwright/test';

type NavPage =
  | 'Dashboard'
  | 'Conversations'
  | 'Clients'
  | 'Catalog'
  | 'Orders'
  | 'Bookings'
  | 'Payments'
  | 'Analytics'
  | 'Settings';

const PAGE_PATHS: Record<NavPage, string> = {
  Dashboard: '/dashboard',
  Conversations: '/conversations',
  Clients: '/clients',
  Catalog: '/catalog',
  Orders: '/orders',
  Bookings: '/bookings',
  Payments: '/payments',
  Analytics: '/analytics',
  Settings: '/settings',
};

export class SidebarNav {
  readonly page: Page;
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.locator('aside');
  }

  link(name: NavPage): Locator {
    return this.sidebar.getByRole('link', { name });
  }

  async navigateTo(target: NavPage) {
    await this.link(target).click();
    await this.page.waitForURL(`**${PAGE_PATHS[target]}**`);
  }

  async expectActivePage(target: NavPage) {
    const link = this.link(target);
    await expect(link).toBeVisible();
    // The active link has a distinct visual style — verify by URL
    await expect(this.page).toHaveURL(new RegExp(PAGE_PATHS[target]));
  }

  async expectVisible() {
    await expect(this.sidebar).toBeVisible();
  }
}
