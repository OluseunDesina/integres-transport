import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

test.describe('validator-app login', () => {
  test('renders an axe-clean login screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Integra Validator' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('a passenger account is rejected with a generic message', async ({ page }) => {
    // validator-app signs in via the same client-admin JWT audience as
    // client-admin-app — a passenger login is rejected the same way,
    // deliberately indistinguishable from "no such account".
    await page.goto('/login');
    await page.getByLabel('Email').fill('e2e-passenger@example.com');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'No active account found' })
    ).toBeVisible();
  });

  test('signs in and lands on an axe-clean record screen', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/record$/);
    await expect(page.getByRole('heading', { name: 'Record a tap' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
