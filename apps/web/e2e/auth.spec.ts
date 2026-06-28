import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login.page';

test.describe('Authentication', () => {
  test.describe('Login', () => {
    test('should show the login page with all elements', async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.expectLoginPage();
      await expect(loginPage.forgotPasswordLink).toBeVisible();
      await expect(loginPage.googleButton).toBeVisible();
      await expect(loginPage.createAccountLink).toBeVisible();
    });

    test('should login with valid credentials and redirect to dashboard', async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login('healthfirst@gosumo.aiknol.com', 'HealthFirst@2026!');

      await page.waitForURL('**/dashboard', { timeout: 15_000 });
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    });

    test('should show error with wrong password', async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login('healthfirst@gosumo.aiknol.com', 'WrongPassword123!');

      // Wait for error message to appear
      await expect(
        page.getByText(/invalid|incorrect|wrong|failed/i)
      ).toBeVisible({ timeout: 10_000 });

      // Should remain on login page
      await expect(page).toHaveURL(/\/login/);
    });

    test('should show validation when submitting empty fields', async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();

      // Click sign in without filling fields
      await loginPage.signInButton.click();

      // Should remain on login page (HTML5 validation or custom validation will prevent submission)
      await expect(page).toHaveURL(/\/login/);
    });
  });

  test.describe('Logout', () => {
    test('should logout and redirect to login page', async ({ page }) => {
      // First login
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login('healthfirst@gosumo.aiknol.com', 'HealthFirst@2026!');
      await page.waitForURL('**/dashboard', { timeout: 15_000 });

      // Open user menu (click on user avatar/name area in topbar)
      const userMenuButton = page.locator('header').getByRole('button').last();
      await userMenuButton.click();

      // Click sign out
      await page.getByRole('menuitem', { name: /sign out/i }).click();

      // Should redirect to login page
      await page.waitForURL('**/login', { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    });
  });

  test.describe('Protected Routes', () => {
    test('should redirect unauthenticated users to login', async ({ page }) => {
      // Try to access dashboard directly without auth
      await page.goto('/dashboard');

      // Should be redirected to login
      await page.waitForURL('**/login', { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    });
  });
});
