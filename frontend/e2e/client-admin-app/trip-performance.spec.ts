import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { selectBusinessByName } from '../session';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const BUSINESS = 'Integra E2E Network Test Business';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('client-admin-app trip performance', () => {
  test('is reached from the trip list itself, not from its action menu', async ({ page }) => {
    // The action menu is wrapped in `scheduling.manage` in its entirety,
    // and read-only `scheduling.view` staff are exactly who performance
    // reporting is for — so the link lives on the row and follows this
    // route's own `analytics.view` guard.
    await signIn(page);
    await selectBusinessByName(page, BUSINESS);
    await page.goto('/trips');

    const link = page.locator('tbody tr td a').first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/performance$/);
    await expect(page.getByRole('heading', { name: 'Trip performance', level: 1 })).toBeVisible();
  });

  test('renders an axe-clean screen with capacity, punctuality and revenue', async ({ page }) => {
    await signIn(page);
    await selectBusinessByName(page, BUSINESS);
    await page.goto('/trips');
    await page.locator('tbody tr td a').first().click();
    await expect(page.getByRole('heading', { name: 'Capacity' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Punctuality' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revenue' })).toBeVisible();
    // The occupancy doughnut carries its numbers for a screen reader
    // too, not only as an arc.
    await expect(page.locator('ui-chart table')).toHaveCount(1);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('says a trip has not departed rather than showing it as on time', async ({ page }) => {
    // Nothing in the seeded fixture has departed, so this is the state
    // the screen actually renders — and "0 minutes late" would be a lie
    // about every one of them.
    await signIn(page);
    await selectBusinessByName(page, BUSINESS);
    await page.goto('/trips');
    await page.locator('tbody tr td a').first().click();

    await expect(page.getByText('Not departed yet')).toBeVisible();
  });

  test('renders a bookmarked link to a missing trip as not found, not as an error', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/trips/00000000-0000-0000-0000-000000000000/performance');

    await expect(page.getByText('Trip not found')).toBeVisible();
    await expect(page.locator('ui-alert')).toHaveCount(0);
  });
});
