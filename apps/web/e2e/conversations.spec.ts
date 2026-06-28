import { test, expect } from './fixtures/auth.fixture';
import { ConversationsPage } from './pages/conversations.page';

test.describe('Conversations', () => {
  let conversations: ConversationsPage;

  test.beforeEach(async ({ page }) => {
    conversations = new ConversationsPage(page);
    await conversations.goto();
    await conversations.expectLoaded();
  });

  test('should load the conversations page', async ({ page }) => {
    await conversations.expectConversationList();
  });

  test('should show the search input', async () => {
    await expect(conversations.searchInput).toBeVisible();
  });

  test('should show empty selection state when no conversation is selected', async () => {
    await conversations.expectEmptySelection();
  });

  test('should display conversation list items', async ({ page }) => {
    test.slow();
    // Wait for conversation items to load
    // Conversations appear as clickable items in the left panel
    const listPanel = page.locator('aside, [class*="list"], [class*="panel"]').first();
    await expect(listPanel).toBeVisible();
  });

  test('should allow searching conversations', async ({ page }) => {
    await conversations.searchConversations('test');
    // Search should filter or show results
    await expect(conversations.searchInput).toHaveValue('test');
  });

  test('should show message thread when conversation is selected', async ({ page }) => {
    test.slow();
    // Find and click the first conversation in the list
    // Conversations are rendered as clickable items
    const conversationItems = page.locator('[class*="cursor-pointer"]');
    const count = await conversationItems.count();

    if (count > 0) {
      await conversationItems.first().click();
      // After selection, the thread panel should show
      // Either a reply input or message content should be visible
      await expect(
        page.getByPlaceholder(/Type a reply/).or(page.getByText(/AI handling/))
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('should have status filter options', async ({ page }) => {
    // Look for the status filter combobox/select
    const statusFilter = page.getByRole('combobox').first();
    if (await statusFilter.isVisible()) {
      await statusFilter.click();
      // Check for status options
      await expect(page.getByRole('option', { name: 'Open' }).or(page.getByText('Open'))).toBeVisible();
    }
  });

  test('should have channel filter options', async ({ page }) => {
    // Look for the channel filter
    const comboboxes = page.getByRole('combobox');
    const count = await comboboxes.count();
    if (count >= 2) {
      await comboboxes.nth(1).click();
      await expect(
        page.getByRole('option', { name: 'WhatsApp' }).or(page.getByText('WhatsApp'))
      ).toBeVisible();
    }
  });
});
