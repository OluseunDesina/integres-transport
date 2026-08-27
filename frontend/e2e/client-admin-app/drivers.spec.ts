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

async function createDriver(
  page: Page,
  name: string,
  licenseNumber: string,
  licenseExpiresAt?: string
): Promise<void> {
  await page.goto('/drivers/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('License number').fill(licenseNumber);
  if (licenseExpiresAt) {
    await page.getByLabel('License expires').fill(licenseExpiresAt);
  }
  await page.getByRole('button', { name: 'Create driver' }).click();
  await expect(page).toHaveURL(/\/drivers$/);
}

test.describe('client-admin-app drivers', () => {
  test('renders an axe-clean drivers screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Drivers' }).click();

    await expect(page).toHaveURL(/\/drivers$/);
    await expect(page.getByRole('heading', { name: 'Drivers' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects an empty driver name and stays axe-clean', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/drivers/new');
    await page.getByLabel('License number').fill(`DL-${uniqueSuffix()}`);
    await page.getByRole('button', { name: 'Create driver' }).click();

    await expect(page).toHaveURL(/\/drivers\/new$/);
    await expect(page.getByText('This field is required.').first()).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a driver, shows it as compliant, and is axe-clean', async ({ page }) => {
    const suffix = uniqueSuffix();
    const name = `E2E Driver ${suffix}`;
    const licenseNumber = `DL-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createDriver(page, name, licenseNumber);

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Compliant')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows a compliance warning pill for an expired license', async ({ page }) => {
    const suffix = uniqueSuffix();
    const name = `E2E Driver Expired ${suffix}`;
    const licenseNumber = `DL-EXP-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createDriver(page, name, licenseNumber, '2020-01-01');

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row.getByText('1 warning(s)')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing driver and shows the updated name', async ({ page }) => {
    const suffix = uniqueSuffix();
    const originalName = `E2E Driver ${suffix}`;
    const updatedName = `${originalName} (updated)`;
    const licenseNumber = `DL-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createDriver(page, originalName, licenseNumber);

    await page
      .getByRole('row', { name: new RegExp(originalName) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit driver' })).toBeVisible();
    await expect(page.getByLabel('Name')).toHaveValue(originalName);

    await page.getByLabel('Name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/drivers$/);
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
