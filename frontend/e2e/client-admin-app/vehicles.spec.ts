import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const NETWORK_BUSINESS = 'Integra E2E Network Test Business';

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

async function createVehicleType(page: Page, name: string): Promise<void> {
  await page.goto('/vehicle-types/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Capacity (seats)').fill('33');
  await page.getByRole('button', { name: 'Create vehicle type' }).click();
  await expect(page).toHaveURL(/\/vehicle-types$/);
}

async function createVehicle(
  page: Page,
  vehicleTypeName: string,
  registration: string,
  insuranceExpiresAt?: string
): Promise<void> {
  await page.goto('/vehicles/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Vehicle type').selectOption({ label: `${vehicleTypeName} (33 seats)` });
  await page.getByLabel('Registration number').fill(registration);
  if (insuranceExpiresAt) {
    await page.getByLabel('Insurance expires').fill(insuranceExpiresAt);
  }
  await page.getByRole('button', { name: 'Create vehicle' }).click();
  await expect(page).toHaveURL(/\/vehicles$/);
}

test.describe('client-admin-app vehicles', () => {
  test('renders an axe-clean vehicles screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Vehicles' }).click();

    await expect(page).toHaveURL(/\/vehicles$/);
    await expect(page.getByRole('heading', { name: 'Vehicles' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a vehicle, shows it as compliant, and is axe-clean', async ({ page }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration);

    const row = page.getByRole('row', { name: new RegExp(registration) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Compliant')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows a compliance warning pill for an expired insurance date', async ({ page }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-EXP-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration, '2020-01-01');

    const row = page.getByRole('row', { name: new RegExp(registration) });
    await expect(row).toBeVisible();
    await expect(row.getByText('1 warning(s)')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing vehicle and shows the updated registration number', async ({ page }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-${suffix}`;
    const updatedRegistration = `${registration}-UPD`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration);

    await page
      .getByRole('row', { name: new RegExp(registration) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit vehicle' })).toBeVisible();
    await expect(page.getByLabel('Registration number')).toHaveValue(registration);
    await expect(page.getByLabel('Business')).toBeDisabled();
    await expect(page.getByLabel('Vehicle type')).toBeDisabled();

    await page.getByLabel('Registration number').fill(updatedRegistration);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/vehicles$/);
    await expect(page.getByText(updatedRegistration)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
