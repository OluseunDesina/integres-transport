import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

function uniqueBusinessName(): string {
  return `E2E Shuttle Co ${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createBusiness(page: Page, name: string): Promise<void> {
  await page.goto('/businesses/new');
  await page.getByLabel('Vertical').selectOption('shuttle');
  await page.getByLabel('Business name').fill(name);
  await page.getByLabel('Currency').fill('NGN');
  await page.getByLabel('Timezone').fill('Africa/Lagos');
  await page.getByLabel('Booking mode').selectOption('reservation');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/businesses$/);
}

test.describe('client-admin-app businesses', () => {
  test('renders an axe-clean businesses screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Businesses' }).click();

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByRole('heading', { name: 'Businesses' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();

    // Sign out now lives inside the profile menu (closed by default),
    // not as its own always-visible button.
    await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejects an empty business name and stays axe-clean', async ({ page }) => {
    await signIn(page);
    await page.goto('/businesses/new');
    await page.getByRole('button', { name: 'Create business' }).click();

    await expect(page.getByText('This field is required.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/businesses\/new$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('creates a business, shows it in the list, and is axe-clean', async ({ page }) => {
    const name = uniqueBusinessName();
    await signIn(page);
    await createBusiness(page, name);

    await expect(page.getByText(name)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('is completable by keyboard alone', async ({ page }) => {
    const name = uniqueBusinessName();
    await signIn(page);
    await page.goto('/businesses/new');

    // Vertical/Booking mode already default to the values this test
    // wants (shuttle/reservation per business-form.ts's FormBuilder
    // defaults) — Tab past both selects without changing them.
    await page.getByLabel('Vertical').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.type(name);
    await page.keyboard.press('Tab');
    await page.keyboard.type('NGN');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Africa/Lagos');
    await page.keyboard.press('Tab'); // past Booking mode select
    await page.keyboard.press('Tab'); // to the Create business button
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByText(name)).toBeVisible();
  });

  test('edits an existing business and shows the updated name', async ({ page }) => {
    const originalName = uniqueBusinessName();
    const updatedName = `${originalName} (updated)`;

    await signIn(page);
    await createBusiness(page, originalName);

    await page
      .getByRole('row', { name: new RegExp(originalName) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit business' })).toBeVisible();
    await expect(page.getByLabel('Business name')).toHaveValue(originalName);

    await page.getByLabel('Business name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('uploads a KYB document from the edit screen and stays axe-clean', async ({ page }) => {
    const name = uniqueBusinessName();
    await signIn(page);
    await createBusiness(page, name);

    await page
      .getByRole('row', { name: new RegExp(name) })
      .getByRole('link', { name: 'Edit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit business' })).toBeVisible();

    await page.getByText('Upload a KYB document').scrollIntoViewIfNeeded();
    await page.getByLabel('Document type').selectOption({ label: 'Tax certificate' });
    await page.getByLabel('File').setInputFiles({
      name: 'tax-cert.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e fixture'),
    });
    await page.getByRole('button', { name: 'Upload document' }).click();

    await expect(page.getByText('submitted', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
