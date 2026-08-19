import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';

function uniqueVehicleTypeName(): string {
  return `E2E Vehicle Type ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// See stops.spec.ts's identical helper/reasoning — Vehicle Types/Vehicles/
// Drivers lists are all scoped to the profile menu's active-Business
// switcher too.
async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

async function createVehicleType(page: Page, name: string, capacity: string): Promise<void> {
  await page.goto('/vehicle-types/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Capacity (seats)').fill(capacity);
  await page.getByRole('button', { name: 'Create vehicle type' }).click();
  await expect(page).toHaveURL(/\/vehicle-types$/);
}

test.describe('client-admin-app vehicle types', () => {
  test('renders an axe-clean vehicle types screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Vehicle Types' }).click();

    await expect(page).toHaveURL(/\/vehicle-types$/);
    await expect(page.getByRole('heading', { name: 'Vehicle Types' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects an empty vehicle type name and stays axe-clean', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/vehicle-types/new');
    await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
    await page.getByLabel('Capacity (seats)').fill('20');
    await page.getByRole('button', { name: 'Create vehicle type' }).click();

    await expect(page).toHaveURL(/\/vehicle-types\/new$/);
    await expect(page.getByText('This field is required.').first()).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a vehicle type, shows it in the list, and is axe-clean', async ({ page }) => {
    const name = uniqueVehicleTypeName();
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, name, '33');

    await expect(page.getByText(name)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing vehicle type and shows the updated name', async ({ page }) => {
    const originalName = uniqueVehicleTypeName();
    const updatedName = `${originalName} (updated)`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, originalName, '14');

    await page
      .getByRole('row', { name: new RegExp(originalName) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit vehicle type' })).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveValue(originalName);
    await expect(page.getByLabel('Business')).toBeDisabled();

    await page.getByLabel('Name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/vehicle-types$/);
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
