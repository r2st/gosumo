import { type Page, type Locator, expect } from '@playwright/test';

type SettingsTab =
  | 'Business'
  | 'Setup Wizard'
  | 'Team'
  | 'Channels'
  | 'AI'
  | 'Notifications'
  | 'Billing'
  | 'API Keys'
  | 'Integrations';

const TAB_PATHS: Record<SettingsTab, string> = {
  Business: '/settings',
  'Setup Wizard': '/settings/setup',
  Team: '/settings/team',
  Channels: '/settings/channels',
  AI: '/settings/ai',
  Notifications: '/settings/notifications',
  Billing: '/settings/billing',
  'API Keys': '/settings/api-keys',
  Integrations: '/settings/integrations',
};

export class SettingsPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Settings', level: 1 });
  }

  async goto() {
    await this.page.goto('/settings');
  }

  tab(name: SettingsTab): Locator {
    return this.page.getByRole('link', { name, exact: true });
  }

  async clickTab(name: SettingsTab) {
    await this.tab(name).click();
    await this.page.waitForURL(`**${TAB_PATHS[name]}**`);
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible();
  }

  async expectTab(name: SettingsTab) {
    await expect(this.page).toHaveURL(new RegExp(TAB_PATHS[name].replace(/\//g, '\\/')));
  }
}
