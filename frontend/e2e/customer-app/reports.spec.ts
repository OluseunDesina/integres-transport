import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';

/** The bookable fixture's operator, which this passenger has bookings
 * with — so it is in `/routes/browse/` and therefore in the operator
 * picker. */
const ROUTE_NAME = 'Ikeja → CMS';

/**
 * Self-seeding: every case that needs a report files one, tagged so it
 * can be found again among the hundreds this dev database accumulates.
 * Nothing is added to `seed_e2e_users` for this spec — and nothing
 * could usefully be, since an incident referencing protected rows is
 * one `prune_e2e_test_data` structurally cannot clear.
 */
function uniqueDescription(): string {
  return `E2E report ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/** Selects the operator by *label*, since the picker is keyed by
 * Business id and this database holds more than one operator. */
async function selectOperator(page: Page): Promise<void> {
  const select = page.getByLabel('Operator');
  const option = select.locator('option').nth(1);
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value')) ?? '');
}

test.describe('customer-app incident reporting', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('renders an axe-clean report form', async ({ page }) => {
    await page.goto('/report-issue');

    await expect(page.getByRole('heading', { name: 'Report an issue' })).toBeVisible();
    await expect(page.getByLabel('Operator')).toBeVisible();
    await expect(page.getByLabel('What went wrong')).toBeVisible();
    await expectAxeClean(page);
  });

  test('rejects an empty submit visibly, not silently', async ({ page }) => {
    await page.goto('/report-issue');

    await page.getByRole('button', { name: 'Send report' }).click();

    // The rendered message, not merely "the URL did not change". A form
    // binding neither [invalid] nor [errorMessage] does nothing visible
    // on an invalid submit, which is how a form in this repo shipped
    // broken.
    await expect(page.getByText('Choose what went wrong.')).toBeVisible();
    await expect(page).toHaveURL(/\/report-issue/);
  });

  test('files a report and shows it in the history with a status', async ({ page }) => {
    const description = uniqueDescription();
    await page.goto('/report-issue');

    await selectOperator(page);
    await page.getByLabel('What went wrong').selectOption({ label: 'Card reader or ticket machine' });
    await page.getByLabel('Tell us what happened').fill(description);
    await page.getByRole('button', { name: 'Send report' }).click();

    await expect(page).toHaveURL(/\/my-reports/);
    // The reference is the only thing this screen gives a passenger to
    // quote, so it has to be on screen rather than merely in the URL.
    await expect(page.getByText(/INC-[0-9A-Z]{6}/).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Received' }).first()).toBeVisible();
  });

  test('shows the reporter status and nothing that belongs to staff', async ({ page }) => {
    await page.goto('/my-reports');

    await expect(page.getByRole('heading', { name: 'My reports' })).toBeVisible();
    // The visibility rule, asserted from the outside: `/incidents/mine/`
    // returns a reduced serializer, so none of this can appear here even
    // once an operator has filled it in.
    await expect(page.getByText('Assigned to')).toHaveCount(0);
    await expect(page.getByText('Resolution notes')).toHaveCount(0);
    await expect(page.getByText('Internal note')).toHaveCount(0);
    await expectAxeClean(page);
  });

  test('reports against a booked trip from the bookings row menu', async ({ page }) => {
    await page.goto('/my-bookings');

    await page
      .getByRole('row', { name: new RegExp(ROUTE_NAME) })
      .first()
      .getByRole('button', { name: new RegExp('^Actions for') })
      .click();
    await page.getByRole('menuitem', { name: 'Report a problem' }).click();

    await expect(page).toHaveURL(/\/report-issue\?booking=/);
    // The trip is named, and there is no operator to pick — the booking
    // already said which one.
    await expect(page.getByText(ROUTE_NAME).first()).toBeVisible();
    await expect(page.getByLabel('Operator')).toHaveCount(0);
    await expectAxeClean(page);

    await page.getByLabel('What went wrong').selectOption({ label: 'Service or staff' });
    await page.getByLabel('Tell us what happened').fill(uniqueDescription());
    await page.getByRole('button', { name: 'Send report' }).click();

    await expect(page).toHaveURL(/\/my-reports/);
  });
});
