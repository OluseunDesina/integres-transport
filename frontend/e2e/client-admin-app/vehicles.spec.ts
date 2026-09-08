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
  await page.getByLabel('Vehicle type').selectOption({ label: `${vehicleTypeName} (33 seats)` });
  await page.getByLabel('Registration number').fill(registration);
  if (insuranceExpiresAt) {
    await page.getByLabel('Insurance expires').fill(insuranceExpiresAt);
  }
  await page.getByRole('button', { name: 'Create vehicle' }).click();
  await expect(page).toHaveURL(/\/vehicles$/);
}

/**
 * Row actions moved from bare text links plus an in-table switch into
 * one `ui-action-menu` per row — docs/specs/14 slice 2. Every action on
 * this screen now goes through here.
 */
async function openRowMenu(page: Page, registration: string): Promise<void> {
  await page
    .getByRole('row', { name: new RegExp(registration) })
    .getByRole('button', { name: `Actions for ${registration}` })
    .click();
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
    // `toContainText` on the row, not `getByText` inside it: a value in
    // a column hidden below `md` also appears in the row's responsive
    // sub-line, so it is in the DOM twice and a text locator is
    // ambiguous by design. The assertion means "the row shows this",
    // which is what this expresses.
    await expect(row).toContainText('Compliant');

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

    await openRowMenu(page, registration);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit vehicle' })).toBeVisible();
    await expect(page.getByLabel('Registration number')).toHaveValue(registration);
    await expect(page.getByLabel('Vehicle type')).toBeDisabled();

    await page.getByLabel('Registration number').fill(updatedRegistration);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/vehicles$/);
    await expect(page.getByText(updatedRegistration)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // --- docs/specs/14 slice 2 ---

  test('deactivates a vehicle only after confirming, and shows the new status', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-ACT-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration);

    const row = page.getByRole('row', { name: new RegExp(registration) });
    await expect(row.getByText('Active')).toBeVisible();

    // Opening the menu must not itself change anything — the whole point
    // of replacing the in-table switch.
    await openRowMenu(page, registration);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The dialog names the vehicle in its heading, so a mis-tap is
    // recoverable before anything is written.
    await expect(
      dialog.getByRole('heading', { name: `Deactivate ${registration}?` }),
    ).toBeVisible();
    // Nothing is written until the dialog is confirmed. Asserted through
    // a CSS locator, not `getByRole('row')`: CDK marks the page behind an
    // open modal `aria-hidden`, so role-based queries correctly find
    // nothing there.
    await expect(
      page.locator('tbody tr', { hasText: registration }).locator('text=Active'),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Deactivate' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText('Inactive')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('leaves the vehicle untouched when the confirmation is cancelled', async ({ page }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-CNL-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration);

    await openRowMenu(page, registration);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    const row = page.getByRole('row', { name: new RegExp(registration) });
    await expect(row.getByText('Active')).toBeVisible();
  });

  test('shows compliance detail in a drawer, and returns focus on close', async ({ page }) => {
    const suffix = uniqueSuffix();
    const vehicleTypeName = `E2E VT ${suffix}`;
    const registration = `LAG-DRW-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration, '2020-01-01');

    await openRowMenu(page, registration);
    await page.getByRole('menuitem', { name: 'View details' }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    // The warning text itself, not just a count — it used to live in a
    // `title` tooltip that touch users never saw.
    await expect(drawer.getByRole('listitem').filter({ hasText: /insurance expired/i })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await drawer.getByRole('button', { name: 'Close panel' }).click();
    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole('button', { name: `Actions for ${registration}` }),
    ).toBeFocused();
  });

  test('keeps a chosen row density after leaving and returning', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.goto('/vehicles');

    await page.getByRole('button', { name: 'Compact rows' }).click();
    await expect(page.getByRole('button', { name: 'Compact rows' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.goto('/home');
    await page.goto('/vehicles');
    await expect(page.getByRole('button', { name: 'Compact rows' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
