import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const EMAIL = 'e2e-platform-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

test.describe('super-admin-app login', () => {
  test('renders an axe-clean login screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a client-staff account is rejected on the super-admin app', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('e2e-client-staff@example.com');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'No active account found' })
    ).toBeVisible();
  });

  test('signs in and lands on an axe-clean home screen showing the account email', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/home$/);
    // Level 1: the rebuilt home screen has section headings below the
    // greeting, so a bare heading lookup is a strict-mode violation.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(EMAIL);
    // The Phase 0 placeholder ("You have super-admin-app access.", plus
    // `Platform staff: true`) is gone — spec 14 slice 6a made this a
    // real landing page. What proves the screen loaded is that its
    // destinations are reachable from it.
    await expect(page.getByRole('link', { name: 'KYC queue' }).last()).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
