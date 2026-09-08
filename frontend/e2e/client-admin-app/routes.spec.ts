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
  await page.getByLabel('Stop name').fill(name);
  await page.getByLabel('Address').fill('12 Awolowo Rd, Ikeja');
  await page.getByRole('button', { name: 'Create stop' }).click();
  await expect(page).toHaveURL(/\/stops$/);
}

async function createRoute(page: Page, name: string): Promise<void> {
  await page.goto('/routes/new');
  await page.getByLabel('Route name').fill(name);
  await page.getByRole('button', { name: 'Create route' }).click();
  // Create navigates straight into edit mode (the stop-order section
  // needs a real route id) — see route-form.ts's onSubmit.
  await expect(page).toHaveURL(/\/routes\/[^/]+\/edit$/);
}

/**
 * Row actions moved from bare text links plus an in-table switch into
 * one `ui-action-menu` per row — docs/specs/14 slice 3a.
 */
async function openRowMenu(page: Page, rowName: string): Promise<void> {
  await page
    .getByRole('row', { name: new RegExp(rowName) })
    .getByRole('button', { name: new RegExp('^Actions for') })
    .click();
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

    await page.getByLabel('Route name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();
    // Route's edit mode deliberately stays on the same page after saving
    // (the Stops tab needs to stay usable) — the confirmation, not the
    // input's own value, is what actually confirms the PATCH completed
    // before navigating away to check the list.
    await expect(page.getByText('Route details saved.')).toBeVisible();

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

    // Details and Stops are tabs now — the two halves of a route are
    // unrelated and both already loaded (docs/specs/14 slice 4).
    await page.getByRole('tab', { name: 'Stops' }).click();
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
    // Named for the stop it moves: a list of identical "Move up"
    // buttons is ambiguous to a screen reader and to a locator alike.
    await items.nth(1).getByRole('button', { name: `Move ${stopA} earlier` }).click();
    await expect(items.nth(0)).toContainText(stopA);
    await expect(items.nth(1)).toContainText(stopB);

    await page.getByRole('button', { name: 'Save stop order' }).click();
    await expect(page.getByText('Stop order saved.')).toBeVisible();

    await page.reload();
    // A reload lands on the first tab, as a fresh visit should.
    await page.getByRole('tab', { name: 'Stops' }).click();
    const reloadedItems = page.locator('ol li');
    await expect(reloadedItems).toHaveCount(2);
    await expect(reloadedItems.nth(0)).toContainText(stopA);
    await expect(reloadedItems.nth(1)).toContainText(stopB);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // --- docs/specs/14 slice 3a ---

  test('deactivates a route only after confirming, and shows the new status', async ({ page }) => {
    const name = uniqueName('E2E Deactivate Route');

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, name);
    await page.goto('/routes');

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row.getByText('Active')).toBeVisible();

    // Opening the menu must not itself change anything — the whole point
    // of replacing the in-table switch.
    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Deactivate ${name}?` })).toBeVisible();
    // Asserted through a CSS locator, not getByRole: CDK marks the page
    // behind an open modal aria-hidden, so role queries correctly find
    // nothing there.
    await expect(page.locator('tbody tr', { hasText: name }).locator('text=Active')).toBeVisible();

    await dialog.getByRole('button', { name: 'Deactivate' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText('Inactive')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('leaves the route untouched when the confirmation is cancelled', async ({ page }) => {
    const name = uniqueName('E2E Cancel Route');

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, name);
    await page.goto('/routes');

    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await expect(
      page.getByRole('row', { name: new RegExp(name) }).getByText('Active'),
    ).toBeVisible();
  });

  test('narrows the list with a server-side search, and clears it from the chip', async ({
    page,
  }) => {
    // The reason slice 3a added `?search=` to the backend: a search that
    // only filtered the loaded page would be indistinguishable from this
    // until the list outgrew one page.
    const name = uniqueName('E2E Searchable Route');
    const other = uniqueName('E2E Unrelated Route');

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, other);
    await createRoute(page, name);
    await page.goto('/routes');

    await expect(page.getByRole('row', { name: new RegExp(other) })).toBeVisible();

    await page.getByLabel('Search routes').fill(name);
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(other) })).toBeHidden();

    // The chip is what tells an operator the list is filtered at all.
    const chip = page.getByRole('button', { name: new RegExp('^Remove filter Search') });
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(page.getByRole('row', { name: new RegExp(other) })).toBeVisible();
  });

  test('creates a route from the shell quick-create menu', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/routes');

    await page.getByRole('button', { name: 'Create a new record' }).click();
    await page.getByRole('menuitem', { name: 'New route' }).click();

    await expect(page).toHaveURL(/\/routes\/new$/);
  });
});
