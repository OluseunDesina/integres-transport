import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { selectBusinessByName } from '../session';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/**
 * The dashboard — spec 16 slice 3. It is what `/home` renders now, so
 * every sign-in in every other spec lands here first.
 *
 * The seeded e2e account is an Owner and therefore holds
 * `analytics.view` (granted to all pre-existing Owner/Manager roles by
 * `identity/0019`). A Staff-role variant of these assertions has no
 * fixture to run against — `seed_e2e_users` seeds one client-staff user
 * — so the permission branch is covered by the component spec instead,
 * named here rather than silently skipped.
 */
test.describe('client-admin-app dashboard', () => {
  test('lands on the dashboard after sign-in and renders it axe-clean', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();

    // Either the figures or the answered-but-empty state — both are
    // valid depending on what this dev database holds, and neither is an
    // error. What must never appear is the error alert.
    await expect(
      page
        .getByRole('heading', { name: 'Operations' })
        .or(page.getByText('Nothing to report for this period'))
    ).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('renders each chart with an accessible data table beside it', async ({ page }) => {
    // The whole point of ui-chart rendering SVG plus a hidden table: a
    // screen-reader user gets the numbers, not a shrug. Asserted on the
    // DOM, per the spec's test plan.
    await signIn(page);
    // Explicitly, not whichever Business happens to sort first: this dev
    // database's newest Businesses are e2e cruft with no activity, and
    // against one of those the dashboard renders its empty state and
    // this test would skip itself forever while looking green.
    await selectBusinessByName(page, 'Integra E2E Network Test Business');
    await page.goto('/home');

    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();

    const chart = page.locator('ui-chart').first();
    await expect(chart.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    const table = chart.locator('table');
    await expect(table).toHaveCount(1);
    // A caption, so the table announces what it describes.
    await expect(table.locator('caption')).not.toHaveText('');
  });

  test('carries the period in the URL so a filtered view is linkable', async ({ page }) => {
    await signIn(page);

    await page.getByLabel('From', { exact: true }).fill('2026-08-01');
    await page.getByLabel('To', { exact: true }).fill('2026-08-31');
    await page.getByLabel('Group by').selectOption('week');

    await expect(page).toHaveURL(/date_from=2026-08-01/);
    await expect(page).toHaveURL(/date_to=2026-08-31/);
    await expect(page).toHaveURL(/granularity=week/);

    // The chip strip says what is being filtered — a screen showing a
    // subset with nothing on it saying so is the confusion ui-filter-bar
    // exists to prevent.
    await expect(page.getByText('From: 2026-08-01')).toBeVisible();

    // And the link survives a reload rather than resetting to today.
    await page.reload();
    await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-08-01');
    await expect(page.getByLabel('Group by')).toHaveValue('week');
  });

  test('reports a range the backend rejects inline, not only as a toast', async ({ page }) => {
    await signIn(page);

    // Reversed range. `AnalyticsFilterSerializer` answers 400 with a
    // **field-keyed** body — `{"date_from": [...]}`, not `{"detail": …}`
    // — and the message names the fix, so it has to reach the operator
    // verbatim rather than as a generic "failed to load".
    await page.getByLabel('From', { exact: true }).fill('2026-08-31');
    await page.getByLabel('To', { exact: true }).fill('2026-08-01');

    const alert = page.locator('ui-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('date_from must not be after date_to');
  });
});
