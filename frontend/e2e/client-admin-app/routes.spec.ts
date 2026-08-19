import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Stop name').fill(name);
  await page.getByLabel('Address').fill('12 Awolowo Rd, Ikeja');
  await page.getByRole('button', { name: 'Create stop' }).click();
  await expect(page).toHaveURL(/\/stops$/);
}

async function createRoute(page: Page, name: string): Promise<void> {
  await page.goto('/routes/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Route name').fill(name);
  await page.getByRole('button', { name: 'Create route' }).click();
  // Create navigates straight into edit mode (the stop-order section
  // needs a real route id) — see route-form.ts's onSubmit.
  await expect(page).toHaveURL(/\/routes\/[^/]+\/edit$/);
}

test.describe('client-admin-app routes', () => {
  test('renders an axe-clean routes screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Routes' }).click();

    await expect(page).toHaveURL(/\/routes$/);
    await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects an empty route name and stays axe-clean', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/routes/new');
    await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
    await page.getByRole('button', { name: 'Create route' }).click();

    await expect(page.getByText('This field is required.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/routes\/new$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a route, shows it in the list, and is axe-clean', async ({ page }) => {
    const name = uniqueName('E2E Route');
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, name);

    await page.goto('/routes');
    await expect(page.getByText(name)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing route and shows the updated name', async ({ page }) => {
    const originalName = uniqueName('E2E Route');
    const updatedName = `${originalName} (updated)`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, originalName);
    await expect(page.getByLabel('Route name')).toHaveValue(originalName);
    await expect(page.getByLabel('Business')).toBeDisabled();

    await page.getByLabel('Route name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();
    // Route's edit mode deliberately stays on the same page after saving
    // (the stop-order section below needs to stay usable) — the "Saved."
    // confirmation, not the input's own value, is what actually confirms
    // the PATCH completed before navigating away to check the list.
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.goto('/routes');
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('orders stops on a route and the order persists on reload, staying axe-clean', async ({
    page,
  }) => {
    const routeName = uniqueName('E2E Route');
    const stopA = uniqueName('E2E Stop A');
    const stopB = uniqueName('E2E Stop B');

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createStop(page, stopA);
    await createStop(page, stopB);
    await createRoute(page, routeName);

    await expect(page.getByText('No stops added yet.')).toBeVisible();

    await page.getByLabel('Add a stop').selectOption({ label: stopB });
    await page.getByRole('button', { name: 'Add' }).click();
    await page.getByLabel('Add a stop').selectOption({ label: stopA });
    await page.getByRole('button', { name: 'Add' }).click();

    const items = page.locator('ol li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(stopB);
    await expect(items.nth(1)).toContainText(stopA);

    // Move stopA (currently second) up so the final order is A, B.
    await items.nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(items.nth(0)).toContainText(stopA);
    await expect(items.nth(1)).toContainText(stopB);

    await page.getByRole('button', { name: 'Save stop order' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.reload();
    const reloadedItems = page.locator('ol li');
    await expect(reloadedItems).toHaveCount(2);
    await expect(reloadedItems.nth(0)).toContainText(stopA);
    await expect(reloadedItems.nth(1)).toContainText(stopB);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
