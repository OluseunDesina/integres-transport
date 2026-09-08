import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

/** The pay-as-you-go fixture's route. Any trip in the picker would do
 * — this screen applies no fare-mode filter — but naming one keeps the
 * selection deterministic in a database that accumulates trips. */
const ROUTE_NAME = 'CBD Loop';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/record$/);
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/** By route name, never by index: this dev/CI database seeds several
 * routes for today, and an index would silently pick whichever departs
 * earliest. Same reasoning `record.spec.ts` already documents. */
async function selectTripByRoute(page: Page, routeName: string): Promise<void> {
  const select = page.getByLabel('Trip');
  const option = select.locator('option', { hasText: routeName }).first();
  await expect(option).toBeAttached();
  await select.selectOption(await option.getAttribute('value'));
}

test.describe('validator-app report-issue', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('is reachable from the nav for a user who can file incidents', async ({ page }) => {
    await page.getByRole('link', { name: 'Report fault' }).click();

    await expect(page).toHaveURL(/\/report-issue$/);
    await expect(page.getByRole('heading', { name: 'Report a problem' })).toBeVisible();
    await expectAxeClean(page);
  });

  test('rejects an empty submit visibly, not silently', async ({ page }) => {
    await page.goto('/report-issue');

    await page.getByRole('button', { name: 'Send report' }).click();

    await expect(page.getByText('Choose the trip this happened on.')).toBeVisible();
    await expect(page.getByText('Give the report a short heading.')).toBeVisible();
  });

  test('says what the report will name before it is sent', async ({ page }) => {
    await page.goto('/report-issue');
    await selectTripByRoute(page, ROUTE_NAME);

    // A form that silently attaches a vehicle registration is a form
    // whose author knows something the conductor does not.
    await expect(page.getByText(new RegExp(`This report will name route ${ROUTE_NAME}`))).toBeVisible();
  });

  test('files against the selected trip and hands back a reference', async ({ page }) => {
    await page.goto('/report-issue');

    await selectTripByRoute(page, ROUTE_NAME);
    await page.getByLabel('Kind of problem').selectOption({ label: 'Hardware' });
    await page.getByLabel('Heading').fill('Card reader has no lights');
    await page.getByLabel('How urgent').selectOption({ label: 'High' });
    await page.getByLabel('Details').fill('Reader is dark and does not beep.');
    await page.getByRole('button', { name: 'Send report' }).click();

    // Something the conductor can quote on the radio.
    await expect(page.getByText(/Reference INC-[0-9A-Z]{6}\./)).toBeVisible();
    await expectAxeClean(page);
  });

  test('keeps the trip selected when reporting something else', async ({ page }) => {
    await page.goto('/report-issue');

    await selectTripByRoute(page, ROUTE_NAME);
    const tripId = await page.getByLabel('Trip').inputValue();
    await page.getByLabel('Kind of problem').selectOption({ label: 'Vehicle' });
    await page.getByLabel('Heading').fill('Rear door sticks');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByText(/Reference INC-/)).toBeVisible();

    await page.getByRole('button', { name: 'Report something else' }).click();

    // Someone who has just found one fault is the most likely person to
    // be about to report a second thing on the same bus.
    await expect(page.getByLabel('Trip')).toHaveValue(tripId);
    await expect(page.getByLabel('Heading')).toHaveValue('');
  });
});
