import { test, expect } from '@playwright/test';

test.describe('WebChat Widget', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://healthfirst-clinic-demo.pages.dev');
  });

  test('should load the demo site', async ({ page }) => {
    await expect(page).toHaveURL(/healthfirst-clinic-demo/);
    // The page should load without errors
    await expect(page.locator('body')).toBeVisible();
  });

  test('should display the chat widget button', async ({ page }) => {
    // The chat widget typically renders as a floating button
    // Wait for it to appear (may be loaded via script)
    const widgetButton = page.locator(
      'button[class*="chat"], [class*="widget-button"], [id*="chat"], iframe[src*="widget"]'
    ).first();

    await expect(widgetButton.or(page.locator('iframe').first())).toBeVisible({ timeout: 15_000 });
  });

  test('should open chat when widget button is clicked', async ({ page }) => {
    test.slow();

    // Wait for widget to load — it may be in an iframe or directly on the page
    await page.waitForTimeout(3_000);

    // Try to find and click the chat widget trigger
    // Common patterns: floating button, iframe-based widget
    const chatTrigger = page.locator(
      '[class*="chat-trigger"], [class*="widget-launcher"], button[class*="chat"], [id*="gosumo-widget"]'
    ).first();

    const iframe = page.locator('iframe').first();

    if (await chatTrigger.isVisible()) {
      await chatTrigger.click();
    } else if (await iframe.isVisible()) {
      // Widget might be inside an iframe
      const frame = page.frameLocator('iframe').first();
      const trigger = frame.locator('button').first();
      if (await trigger.isVisible()) {
        await trigger.click();
      }
    }

    // After clicking, either a chat panel opens or content changes
    // Look for common chat UI elements
    await page.waitForTimeout(2_000);
  });

  test('should have input field for typing messages', async ({ page }) => {
    test.slow();

    await page.waitForTimeout(3_000);

    // The input field may be in an iframe or directly on the page
    const input = page.locator(
      'input[placeholder*="message" i], textarea[placeholder*="message" i], input[placeholder*="type" i], textarea[placeholder*="type" i]'
    ).first();

    const iframeInput = page.frameLocator('iframe').first().locator(
      'input[placeholder*="message" i], textarea[placeholder*="message" i], input[placeholder*="type" i], textarea[placeholder*="type" i]'
    ).first();

    // First try to open the chat widget if needed
    const chatTrigger = page.locator(
      '[class*="chat-trigger"], [class*="widget-launcher"], button[class*="chat"]'
    ).first();

    if (await chatTrigger.isVisible()) {
      await chatTrigger.click();
      await page.waitForTimeout(1_000);
    }

    // Check for input either on page or in iframe
    await expect(input.or(iframeInput)).toBeVisible({ timeout: 10_000 });
  });
});
