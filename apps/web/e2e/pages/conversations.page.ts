import { type Page, type Locator, expect } from '@playwright/test';

export class ConversationsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchInput: Locator;
  readonly emptyStateHeading: Locator;
  readonly replyInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Conversations', level: 1 });
    this.searchInput = page.getByPlaceholder('Search conversations...');
    this.emptyStateHeading = page.getByText('Select a conversation');
    this.replyInput = page.getByPlaceholder(/Type a reply/);
  }

  async goto() {
    await this.page.goto('/conversations');
  }

  conversationItem(name: string): Locator {
    return this.page.getByText(name);
  }

  async selectConversation(name: string) {
    await this.conversationItem(name).first().click();
  }

  async searchConversations(query: string) {
    await this.searchInput.fill(query);
  }

  async filterByStatus(status: string) {
    // The status filter is a select element
    await this.page.getByRole('combobox').first().click();
    await this.page.getByRole('option', { name: status }).click();
  }

  async filterByChannel(channel: string) {
    // The channel filter is the second combobox
    await this.page.getByRole('combobox').nth(1).click();
    await this.page.getByRole('option', { name: channel }).click();
  }

  async expectLoaded() {
    await expect(this.searchInput).toBeVisible();
  }

  async expectMessageThread() {
    await expect(this.replyInput).toBeVisible();
  }

  async expectConversationList() {
    await expect(this.searchInput).toBeVisible();
  }

  async expectEmptySelection() {
    await expect(this.emptyStateHeading).toBeVisible();
  }
}
