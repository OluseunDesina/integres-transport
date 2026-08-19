import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';

test.describe('customer-app login', () => {
  test('renders an axe-clean login screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows field-level validation errors and stays axe-clean', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'required' }).first()).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows a generic error banner on wrong credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('wrong-password');
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
    // The Phase 0 placeholder ("You have customer-app access.") was
    // replaced by the real home screen once the booking flow existed to
    // link to — docs/specs/4-fares-seating-booking-frontend.md §4.1.
    await expect(page.getByRole('button', { name: 'Search trips' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is completable by keyboard alone', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').click();
    await page.keyboard.type(EMAIL);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/home$/);
  });
});
