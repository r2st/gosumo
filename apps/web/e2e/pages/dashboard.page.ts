import { type Page, type Locator, expect } from '@playwright/test';

export class DashboardPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly recentActivitySection: Locator;
  readonly viewAllLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    this.recentActivitySection = page.getByText('Recent activity');
    this.viewAllLink = page.getByRole('link', { name: 'View all' });
  }

  async goto() {
    await this.page.goto('/dashboard');
  }

  kpiCard(name: string): Locator {
    return this.page.getByText(name).first();
  }

  chartSection(title: string): Locator {
    return this.page.getByText(title);
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible();
  }

  async expectKpiCardsVisible() {
    const kpis = ['Conversations', 'Avg response time', 'Resolution rate', 'Revenue', 'Active bookings'];
    for (const kpi of kpis) {
      await expect(this.kpiCard(kpi)).toBeVisible();
    }
  }

  async expectChartsVisible() {
    const charts = [
      'Conversation volume (7 days)',
      'AI vs human resolution',
    ];
    for (const chart of charts) {
      await expect(this.chartSection(chart)).toBeVisible();
    }
  }
}
