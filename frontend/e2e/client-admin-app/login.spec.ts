import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

test.describe('client-admin-app login', () => {
  test('renders an axe-clean login screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a passenger account is rejected on the client-admin app with a generic message', async ({
    page,
  }) => {
    // Deliberately indistinguishable from "no such account" — the app
    // must not leak that this email exists under a different role.
    await page.goto('/login');
    await page.getByLabel('Email').fill('e2e-passenger@example.com');
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
    await expect(page.getByRole('heading')).toContainText(EMAIL);
    await expect(page.getByText('You have client-admin-app access.')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
