import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function createRoute(page: Page, name: string): Promise<void> {
  await page.goto('/routes/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Route name').fill(name);
  await page.getByRole('button', { name: 'Create route' }).click();
  // Route creation navigates to its own edit page (to let stops be
  // added next), not back to the list — see route-form.ts's onSubmit().
  await expect(page).toHaveURL(/\/routes\/[^/]+\/edit$/);
}

async function createVehicleType(page: Page, name: string): Promise<void> {
  await page.goto('/vehicle-types/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Capacity (seats)').fill('33');
  await page.getByRole('button', { name: 'Create vehicle type' }).click();
  await expect(page).toHaveURL(/\/vehicle-types$/);
}

async function createVehicle(page: Page, vehicleTypeName: string, registration: string): Promise<void> {
  await page.goto('/vehicles/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Vehicle type').selectOption({ label: `${vehicleTypeName} (33 seats)` });
  await page.getByLabel('Registration number').fill(registration);
  await page.getByRole('button', { name: 'Create vehicle' }).click();
  await expect(page).toHaveURL(/\/vehicles$/);
}

async function createDriver(page: Page, name: string, licenseNumber: string): Promise<void> {
  await page.goto('/drivers/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('License number').fill(licenseNumber);
  await page.getByRole('button', { name: 'Create driver' }).click();
  await expect(page).toHaveURL(/\/drivers$/);
}

async function selectAndWaitForAssignment(page: Page, select: Locator, label: string): Promise<void> {
  // A native selectOption() sets the DOM's selected option directly —
  // it does not wait for the async PATCH-then-refetch round trip the
  // change triggers (see trip-list.ts's onVehicleChange/onDriverChange:
  // each assignment PATCH sends the row's *current* vehicle+driver
  // together, so a second change fired before the first's refetch lands
  // would race against stale data). Waiting for the PATCH response and
  // its follow-up GET refetch here mirrors a real user who isn't faster
  // than the network.
  const patchResponse = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/api/v1/trips/')
  );
  await select.selectOption({ label });
  await patchResponse;
  await page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().includes('/api/v1/trips/?')
  );
}

async function createManualTrip(
  page: Page,
  routeName: string,
  serviceDate: string
): Promise<void> {
  await page.goto('/trips/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Route').selectOption({ label: routeName });
  await page.getByLabel('Service date').fill(serviceDate);
  await page.getByLabel('Departure time').fill('08:00');
  await page.getByRole('button', { name: 'Create trip' }).click();
  await expect(page).toHaveURL(/\/trips$/);
}

// Scopes the list to a single Route via the filter bar. Trip's default
// ordering is by service_date (not created_at), and this whole file's
// own repeated runs accumulate trips across many service dates — without
// this, a freshly created trip can land past page 1's 25-row window and
// make an unfiltered row lookup flaky/fail outright. A real user with a
// specific trip in mind would filter too, so this also reads naturally.
async function filterByRoute(page: Page, routeName: string): Promise<void> {
  await page.getByLabel('Route', { exact: true }).selectOption({ label: routeName });
  await expect(page.getByRole('row', { name: new RegExp(routeName) }).first()).toBeVisible();
}

test.describe('client-admin-app trips', () => {
  test('renders an axe-clean trips screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Trips' }).click();

    await expect(page).toHaveURL(/\/trips$/);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a manual trip, shows it as scheduled, and is axe-clean', async ({ page }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Route ${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createManualTrip(page, routeName, '2026-09-15');
    await filterByRoute(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row).toBeVisible();
    await expect(row.getByText('scheduled')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('filters the list by service date', async ({ page }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Filter Route ${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createManualTrip(page, routeName, '2026-09-20');

    await page.goto('/trips');
    await page.getByLabel('Service date').fill('2026-09-20');

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row).toBeVisible();

    await page.getByLabel('Service date').fill('2026-09-21');
    await expect(row).not.toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('assigns a vehicle and driver inline from the list', async ({ page }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Assign Route ${suffix}`;
    const vehicleTypeName = `E2E Trip VT ${suffix}`;
    const registration = `TRP-${suffix}`;
    const driverName = `E2E Trip Driver ${suffix}`;
    const licenseNumber = `TRP-DL-${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createVehicleType(page, vehicleTypeName);
    await createVehicle(page, vehicleTypeName, registration);
    await createDriver(page, driverName, licenseNumber);
    await createManualTrip(page, routeName, '2026-09-22');
    await filterByRoute(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await selectAndWaitForAssignment(page, row.getByLabel('Vehicle'), registration);
    await selectAndWaitForAssignment(page, row.getByLabel('Driver'), driverName);

    await page.reload();
    await filterByRoute(page, routeName);
    const reloadedRow = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(reloadedRow.getByLabel('Vehicle').locator('option:checked')).toHaveText(
      registration
    );
    await expect(reloadedRow.getByLabel('Driver').locator('option:checked')).toHaveText(
      driverName
    );

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('transitions a trip scheduled -> in_progress -> completed via the status dialog', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Status Route ${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createManualTrip(page, routeName, '2026-09-23');
    await filterByRoute(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await row.getByRole('button', { name: 'Change status' }).click();

    let dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Start trip').check();

    const resultsOpen = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(resultsOpen.violations).toEqual([]);

    await dialog.getByRole('button', { name: 'Start trip' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row.getByText('In progress')).toBeVisible();

    await row.getByRole('button', { name: 'Change status' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Complete trip').check();
    await dialog.getByRole('button', { name: 'Complete trip' }).click();

    await expect(dialog).not.toBeVisible();
    await expect(row.getByText('completed')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Change status' })).not.toBeVisible();
  });

  test('cancelling a trip requires a reason', async ({ page }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Cancel Route ${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createManualTrip(page, routeName, '2026-09-24');
    await filterByRoute(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await row.getByRole('button', { name: 'Change status' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Cancel trip').check();
    const cancelButton = dialog.getByRole('button', { name: 'Cancel trip' });
    await expect(cancelButton).toBeDisabled();

    await dialog.getByLabel('Reason').fill('Vehicle broke down.');
    await expect(cancelButton).toBeEnabled();

    const resultsOpen = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(resultsOpen.violations).toEqual([]);

    await cancelButton.click();

    await expect(dialog).not.toBeVisible();
    await expect(row.getByText('cancelled')).toBeVisible();
  });

  test('is dismissible with Escape, restoring focus to the row that opened it', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const routeName = `E2E Trip Escape Route ${suffix}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createManualTrip(page, routeName, '2026-09-25');
    await filterByRoute(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    const changeStatusButton = row.getByRole('button', { name: 'Change status' });
    await changeStatusButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
  });
});
