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

async function createRoute(page: Page, name: string): Promise<void> {
  await page.goto('/routes/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Route name').fill(name);
  await page.getByRole('button', { name: 'Create route' }).click();
  // Route creation navigates to its own edit page (to let stops be
  // added next), not back to the list — see route-form.ts's onSubmit().
  await expect(page).toHaveURL(/\/routes\/[^/]+\/edit$/);
}

async function createSchedule(page: Page, routeName: string): Promise<void> {
  await page.goto('/schedules/new');
  await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
  await page.getByLabel('Route').selectOption({ label: routeName });
  await page.getByLabel('Mon').check();
  await page.getByLabel('Wed').check();
  await page.getByLabel('Departure time').fill('07:30');
  await page.getByLabel('Effective from').fill('2026-01-01');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page).toHaveURL(/\/schedules$/);
}

test.describe('client-admin-app schedules', () => {
  test('renders an axe-clean schedules screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await page.getByRole('link', { name: 'Schedules' }).click();

    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects a schedule with no days of week selected', async ({ page }) => {
    const routeName = `E2E Route ${uniqueSuffix()}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);

    await page.goto('/schedules/new');
    await page.getByLabel('Business').selectOption({ label: NETWORK_BUSINESS });
    await page.getByLabel('Route').selectOption({ label: routeName });
    await page.getByLabel('Departure time').fill('07:30');
    await page.getByLabel('Effective from').fill('2026-01-01');
    await page.getByRole('button', { name: 'Create schedule' }).click();

    await expect(page).toHaveURL(/\/schedules\/new$/);
    await expect(page.getByText('Select at least one day of the week.')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a schedule, shows it in the list, and is axe-clean', async ({ page }) => {
    const routeName = `E2E Route ${uniqueSuffix()}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createSchedule(page, routeName);

    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Mon/Wed')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits an existing schedule and shows the updated days', async ({ page }) => {
    const routeName = `E2E Route ${uniqueSuffix()}`;

    await signIn(page);
    await selectActiveBusiness(page, NETWORK_BUSINESS);
    await createRoute(page, routeName);
    await createSchedule(page, routeName);

    await page
      .getByRole('row', { name: new RegExp(routeName) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit schedule' })).toBeVisible();
    await expect(page.getByLabel('Business')).toBeDisabled();
    await expect(page.getByLabel('Route')).toBeDisabled();
    await expect(page.getByLabel('Mon')).toBeChecked();

    await page.getByLabel('Fri').check();
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/schedules$/);
    const row = page.getByRole('row', { name: new RegExp(routeName) });
    await expect(row.getByText('Mon/Wed/Fri')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
