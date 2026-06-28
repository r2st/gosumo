import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

const authFile = path.join(__dirname, '.auth', 'user.json');

setup('authenticate', async ({ page }) => {
  // Navigate to login page
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // Fill credentials
  await page.getByLabel('Email').fill('healthfirst@gosumo.aiknol.com');
  await page.getByLabel('Password').fill('HealthFirst@2026!');

  // Submit the form
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for redirect to dashboard
  await page.waitForURL('**/dashboard', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Save storage state (cookies + localStorage)
  await page.context().storageState({ path: authFile });
});
