import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const CLIENT_NAME = 'Integra E2E Test Client';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';
const KYB_BUSINESS = 'Integra E2E KYB Review Business';

function uniqueRouteName(): string {
  return `E2E Route ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function profileTrigger(page: Page) {
  return page.getByRole('button', { name: new RegExp(EMAIL) });
}

async function openMenu(page: Page): Promise<void> {
  await profileTrigger(page).click();
}

async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await page.getByRole('menuitemradio', { name }).click();
}

async function createRoute(page: Page, name: string, business: string): Promise<void> {
  await page.goto('/routes/new');
  await page.getByLabel('Business').selectOption({ label: business });
  await page.getByLabel('Route name').fill(name);
  await page.getByRole('button', { name: 'Create route' }).click();
  await expect(page).toHaveURL(/\/routes\/[^/]+\/edit$/);
}

test.describe('client-admin-app profile menu', () => {
  test('is closed by default and opens on trigger click', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('menu')).not.toBeVisible();

    await openMenu(page);

    await expect(page.getByRole('menu', { name: 'Account menu' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows email, role, and Client name', async ({ page }) => {
    await signIn(page);
    await openMenu(page);

    const menu = page.getByRole('menu', { name: 'Account menu' });
    await expect(menu.getByText(EMAIL)).toBeVisible();
    await expect(menu.getByText('Owner', { exact: false })).toBeVisible();
    await expect(menu.getByText(CLIENT_NAME, { exact: false })).toBeVisible();
  });

  test('closes on Escape and returns focus to the trigger', async ({ page }) => {
    await signIn(page);
    await openMenu(page);
    await expect(page.getByRole('menu')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).not.toBeVisible();
    await expect(profileTrigger(page)).toBeFocused();
  });

  test('closes when clicking outside the menu', async ({ page }) => {
    await signIn(page);
    await openMenu(page);
    await expect(page.getByRole('menu')).toBeVisible();

    await page.locator('main').click();

    await expect(page.getByRole('menu')).not.toBeVisible();
  });

  test('lists the Client\'s Businesses with the active one checked', async ({ page }) => {
    await signIn(page);
    await openMenu(page);

    const networkRow = page.getByRole('menuitemradio', { name: NETWORK_BUSINESS });
    const kybRow = page.getByRole('menuitemradio', { name: KYB_BUSINESS });
    await expect(networkRow).toBeVisible();
    await expect(kybRow).toBeVisible();
    // Exactly one row is checked at a time (whichever is currently active).
    const checkedCount = await page.getByRole('menuitemradio', { checked: true }).count();
    expect(checkedCount).toBe(1);
  });

  test('switching Business scopes /routes to it, and the choice persists on reload', async ({
    page,
  }) => {
    const routeName = uniqueRouteName();

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName, NETWORK_BUSINESS);

    await page.goto('/routes');
    await expect(page.getByText(routeName)).toBeVisible();

    // Switch to a different Business with no Routes of its own — the
    // just-created Route must disappear, proving the list is actually
    // scoped, not just re-fetched.
    await selectActiveBusiness(page, KYB_BUSINESS);
    await page.goto('/routes');
    await expect(page.getByText(routeName)).not.toBeVisible();

    await page.reload();
    await openMenu(page);
    await expect(page.getByRole('menuitemradio', { name: KYB_BUSINESS })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // openMenu() toggles the trigger, so leaving the menu open here would
    // make the next selectActiveBusiness() call's own openMenu() close it
    // instead of opening it — close explicitly before reusing the helper.
    await page.keyboard.press('Escape');

    // Switch back so this test doesn't leave the fixture account
    // pointed at a Business other e2e specs don't expect.
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/routes');
    await expect(page.getByText(routeName)).toBeVisible();
  });

  test('Sign out (moved into the menu) still works', async ({ page }) => {
    await signIn(page);
    await openMenu(page);

    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
  });

  test('is axe-clean with the menu open', async ({ page }) => {
    await signIn(page);
    await openMenu(page);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
