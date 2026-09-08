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

/**
 * The revenue screen and its exports — spec 16 slice 4.
 *
 * The Business is pinned rather than left to whichever sorts first:
 * this dev database's newest Businesses are accumulated e2e cruft with
 * no payments at all, and against one of those every assertion here
 * would be testing the empty state while looking green.
 */
test.describe('client-admin-app revenue', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await selectBusinessByName(page, BUSINESS);
  });

  test('renders an axe-clean revenue screen with net and gross side by side', async ({ page }) => {
    await page.getByRole('link', { name: 'Revenue' }).click();

    await expect(page).toHaveURL(/\/revenue$/);
    await expect(page.getByRole('heading', { name: 'Revenue', level: 1 })).toBeVisible();
    // Both, always — "revenue" alone is ambiguous, and reading a gross
    // figure as money you will receive is a real way to be misled.
    // Scoped to the stat cards: "Net revenue" also appears as a chart
    // heading and inside that chart's own accessible table.
    const stats = page.locator('ui-stat');
    await expect(stats.filter({ hasText: 'Net revenue' }).first()).toBeVisible();
    await expect(stats.filter({ hasText: 'Gross' }).first()).toBeVisible();
    await expect(stats.filter({ hasText: 'Commission' }).first()).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('renders every chart with an accessible data table beside it', async ({ page }) => {
    await page.goto('/revenue');
    await expect(page.getByRole('heading', { name: 'By route' })).toBeVisible();

    const charts = page.locator('ui-chart');
    await expect(charts).not.toHaveCount(0);
    for (const chart of await charts.all()) {
      await expect(chart.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      await expect(chart.locator('table')).toHaveCount(1);
    }
  });

  test('carries the period in the URL so a filtered view is linkable', async ({ page }) => {
    await page.goto('/revenue');
    await page.getByLabel('From', { exact: true }).fill('2026-08-01');
    await page.getByLabel('To', { exact: true }).fill('2026-08-31');
    await page.getByLabel('Group by').selectOption('week');

    await expect(page).toHaveURL(/date_from=2026-08-01/);
    await expect(page).toHaveURL(/granularity=week/);
    await expect(page.getByText('From: 2026-08-01')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-08-01');
  });

  test('downloads a CSV whose filename and header row are the real thing', async ({ page }) => {
    // The whole point of the server-side export: this is every matching
    // row, not the page on screen. Asserted on the actual downloaded
    // bytes rather than on the request having been made.
    await page.goto('/revenue?date_from=2026-08-01&date_to=2026-08-31');
    await expect(page.getByRole('heading', { name: 'By route' })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export revenue by route as CSV' }).click();
    await page.getByRole('menuitem', { name: 'CSV' }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe(
      'integra-route-revenue-2026-08-01-to-2026-08-31.csv'
    );
    const path = await file.path();
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(path, 'utf-8').replace(/^﻿/, '');
    // `gross_amount`, not `amount` — the revenue file's own `revenue`
    // column is net, and two files with a column called `amount` meaning
    // different things is the wrongness this spec exists to prevent.
    expect(body.split('\r\n')[0]).toBe(
      'date_from,date_to,timezone,route,currency,gross_amount,transaction_volume'
    );
  });

  test('offers one export scope, not two that would produce the same file', async ({ page }) => {
    await page.goto('/revenue');
    await page.getByRole('button', { name: 'Export revenue by route as CSV' }).click();

    await expect(page.getByRole('menuitem')).toHaveCount(1);
    await expect(page.getByRole('menu')).not.toContainText('All results');
  });

  test('reports a range the backend rejects inline, not only transiently', async ({ page }) => {
    await page.goto('/revenue');
    await page.getByLabel('From', { exact: true }).fill('2026-08-31');
    await page.getByLabel('To', { exact: true }).fill('2026-08-01');

    await expect(page.locator('ui-alert')).toContainText('date_from must not be after date_to');
  });
});
