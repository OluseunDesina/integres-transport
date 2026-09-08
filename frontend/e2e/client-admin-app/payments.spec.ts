import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
 * The transactions screen — the payments list, which spec 16 slice 4
 * extended with a metrics strip, the shared period filter and a CSV
 * export. This app had no payments e2e spec at all before now.
 */
test.describe('client-admin-app payments', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await selectBusinessByName(page, BUSINESS);
    await page.goto('/payments');
  });

  test('renders an axe-clean screen with the metrics strip above the table', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
    await expect(page.getByText('Needs manual refund')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Payments' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('lists payments older than the default analytics period', async ({ page }) => {
    // A real, shipped bug this slice fixed: from spec 16 slice 2 until
    // slice 4 this list silently showed only the last 30 days, because
    // it narrowed through the *aggregate* filter function. A support
    // screen that cannot find a two-month-old payment is broken, and
    // nothing on it said so.
    //
    // The seeded payments are from a fixed past date, so their presence
    // with no period set is exactly the assertion.
    const rows = page.locator('tbody tr');
    await expect(rows).not.toHaveCount(0);
    await expect(page.locator('ui-alert')).toHaveCount(0);
  });

  test('narrows both the strip and the table with one period', async ({ page }) => {
    // If they were refreshed separately, a strip describing the previous
    // filter set would be indistinguishable from one describing this.
    await page.getByLabel('From', { exact: true }).fill('2030-01-01');
    await page.getByLabel('To', { exact: true }).fill('2030-01-31');

    await expect(page.getByText('From: 2030-01-01')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.getByText('Payments', { exact: true }).first()).toBeVisible();
    await expect(page).toHaveURL(/date_from=2030-01-01/);
  });

  test('downloads the transactions CSV, carrying the passenger columns', async ({ page }) => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export these payments as CSV' }).click();
    await page.getByRole('menuitem', { name: 'CSV' }).click();
    const file = await download;

    // No period named, so the file contains everything — and its name
    // says so rather than claiming a window it does not respect.
    expect(file.suggestedFilename()).toBe('integra-transactions-all.csv');

    const body = readFileSync(await file.path(), 'utf-8').replace(/^﻿/, '');
    const [header, ...rows] = body.split('\r\n');
    expect(header).toContain('total_paid');
    expect(header).toContain('passenger_email');
    expect(rows.filter((row) => row.trim()).length).toBeGreaterThan(0);
  });
});
