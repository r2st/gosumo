import { test, expect } from './fixtures/auth.fixture';
import { SettingsPage } from './pages/settings.page';

test.describe('Settings', () => {
  let settings: SettingsPage;

  test.beforeEach(async ({ page }) => {
    settings = new SettingsPage(page);
    await settings.goto();
    await settings.expectLoaded();
  });

  test('should load the settings page', async () => {
    await expect(settings.heading).toBeVisible();
  });

  test.describe('Tab Navigation', () => {
    const tabs = [
      'Business' as const,
      'Setup Wizard' as const,
      'Team' as const,
      'Channels' as const,
      'AI' as const,
      'Notifications' as const,
      'Billing' as const,
      'API Keys' as const,
      'Integrations' as const,
    ];

    for (const tab of tabs) {
      test(`should navigate to ${tab} tab`, async () => {
        await settings.clickTab(tab);
        await settings.expectTab(tab);
      });
    }
  });

  test('should show business profile form on Business tab', async ({ page }) => {
    // Business tab is the default
    await expect(page.getByText('Business profile')).toBeVisible();
  });

  test('should show team members on Team tab', async ({ page }) => {
    await settings.clickTab('Team');
    await expect(page.getByText('Team members')).toBeVisible();
  });

  test('should show invite member button on Team tab', async ({ page }) => {
    await settings.clickTab('Team');
    await expect(page.getByRole('button', { name: 'Invite member' })).toBeVisible();
  });

  test('should show billing info on Billing tab', async ({ page }) => {
    await settings.clickTab('Billing');
    // Billing page should show plan information
    await expect(page.getByText(/plan/i)).toBeVisible({ timeout: 10_000 });
  });

  test('should show connected channels on Channels tab', async ({ page }) => {
    await settings.clickTab('Channels');
    await expect(page.getByText('Connected channels')).toBeVisible();
  });

  test('should show AI configuration on AI tab', async ({ page }) => {
    await settings.clickTab('AI');
    await expect(page.getByText('Confidence routing')).toBeVisible();
  });

  test('should show business hours on Business tab', async ({ page }) => {
    await expect(page.getByText('Business hours')).toBeVisible();
  });
});
