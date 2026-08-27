import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';

function uniqueStopName(): string {
  return `E2E Stop ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// Routes/Stops lists are now scoped to whichever Business is "active"
// in the profile menu's switcher (defaults to the most recently created
// Business for this seeded e2e Client, which accumulates new Businesses
// across other spec files' own runs) — explicitly switch to the fixed
// NETWORK_BUSINESS fixture right after signing in so these tests don't
// depend on default-selection ordering.
async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

async function createStop(page: Page, name: string): Promise<void> {
  await page.goto('/stops/new');
  await page.getByLabel('Stop name').fill(name);
  await page.getByLabel('Address').fill('12 Awolowo Rd, Ikeja');
  await page.getByRole('button', { name: 'Create stop' }).click();
  await expect(page).toHaveURL(/\/stops$/);
}

test.describe('client-admin-app stops', () => {
  test('renders an axe-clean stops screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Stops' }).click();

    await expect(page).toHaveURL(/\/stops$/);
    await expect(page.getByRole('heading', { name: 'Stops' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects a stop with no address or coordinates and stays axe-clean', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/stops/new');
    await page.getByLabel('Stop name').fill(uniqueStopName());
    await page.getByRole('button', { name: 'Create stop' }).click();

    await expect(
      page.getByText('Provide an address or both latitude and longitude.')
    ).toBeVisible();
    await expect(page).toHaveURL(/\/stops\/new$/);

    // This is a server-validated error (submitting flips true then back
    // to false), so ui-button's `transition` class animates the submit
    // button's colors back from its disabled-while-submitting treatment
    // to its normal enabled one — same non-deterministic mid-transition
    // axe-contrast race the Phase 2 self-check root-caused and fixed in
    // kyc-status.spec.ts. Wait for the button to actually be enabled
    // again, then let the ~150ms CSS transition settle before scanning.
    const submitButton = page.getByRole('button', { name: 'Create stop' });
    await expect(submitButton).toBeEnabled();
    await page.waitForTimeout(250);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a stop with only coordinates, shows it in the list, and is axe-clean', async ({
    page,
  }) => {
    const name = uniqueStopName();
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/stops/new');
    await page.getByLabel('Stop name').fill(name);
    await page.getByLabel('Latitude').fill('6.524379');
    await page.getByLabel('Longitude').fill('3.379206');
    await page.getByRole('button', { name: 'Create stop' }).click();

    await expect(page).toHaveURL(/\/stops$/);
    await expect(page.getByText(name)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing stop and shows the updated name', async ({ page }) => {
    const originalName = uniqueStopName();
    const updatedName = `${originalName} (updated)`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createStop(page, originalName);

    await page
      .getByRole('row', { name: new RegExp(originalName) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit stop' })).toBeVisible();
    await expect(page.getByLabel('Stop name')).toHaveValue(originalName);

    await page.getByLabel('Stop name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/stops$/);
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
