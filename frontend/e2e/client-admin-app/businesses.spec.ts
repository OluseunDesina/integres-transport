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
  // Both are <select>s now, not free text — a currency had to be a real
  // supported code and a timezone a real IANA zone, and typing either
  // wrong only failed much later (at Paystack, or inside trip
  // generation). The timezone option label strips the "Africa/" prefix.
  await page.getByLabel('Currency').selectOption('NGN');
  await page.getByLabel('Timezone').selectOption('Africa/Lagos');
  await page.getByLabel('Booking mode').selectOption('reservation');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/businesses$/);
}

/**
 * Row actions moved from bare text links and in-row write controls into
 * one `ui-action-menu` per row — docs/specs/14 slice 3b.
 */
async function openRowMenu(page: Page, rowName: string): Promise<void> {
  await page
    .getByRole('row', { name: new RegExp(rowName) })
    .getByRole('button', { name: new RegExp('^Actions for') })
    .click();
}

test.describe('client-admin-app businesses', () => {
  test('renders an axe-clean businesses screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Businesses' }).click();

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByRole('heading', { name: 'Businesses' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();

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

    // Every mode control already defaults to what this test wants
    // (shuttle / reservation / prepaid / flat, plus seat selection on,
    // per business-form.ts's FormBuilder defaults) — Tab past them
    // without changing anything. Each stop is named, because the count
    // is what breaks when a control is added: the seat-selection switch
    // and the fare-collection select both landed here in
    // docs/specs/10-booking-modes.md slice 4, and this test caught it.
    await page.getByLabel('Vertical').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.type(name);
    await page.keyboard.press('Tab');
    await page.keyboard.type('NGN');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Africa/Lagos');
    await page.keyboard.press('Tab'); // Booking mode select
    await page.keyboard.press('Tab'); // seat-selection switch
    await page.keyboard.press('Tab'); // Fare collection mode select
    await page.keyboard.press('Tab'); // Fare pricing mode select
    await page.keyboard.press('Tab'); // Create business button
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByText(name)).toBeVisible();
  });

  test('edits an existing business and shows the updated name', async ({ page }) => {
    const originalName = uniqueBusinessName();
    const updatedName = `${originalName} (updated)`;

    await signIn(page);
    await createBusiness(page, originalName);

    await openRowMenu(page, originalName);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit business' })).toBeVisible();
    await expect(page.getByLabel('Business name')).toHaveValue(originalName);

    await page.getByLabel('Business name').fill(updatedName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page).toHaveURL(/\/businesses$/);
    await expect(page.getByText(updatedName)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('adds a director and uploads KYB documents, staying axe-clean', async ({ page }) => {
    // KYB moved off the business edit form onto its own screen — see
    // docs/specs/11-kyb-directors.md. The old form was one document-type
    // select plus a file input, with nowhere to record director identity
    // and no way to see what had already been supplied.
    const name = uniqueBusinessName();
    await signIn(page);
    await createBusiness(page, name);

    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit business' })).toBeVisible();
    await page.getByRole('link', { name: 'Open verification' }).click();
    await expect(
      page.getByRole('heading', { name: 'Business verification (KYB)' }),
    ).toBeVisible();

    await page.getByLabel('Full name').fill('Ada Okafor');
    await page.getByLabel('ID type').selectOption('nin');
    await page.getByRole('button', { name: 'Add director' }).click();
    // `exact` matters: the name also appears inside that director's
    // "Upload Ada Okafor's ID" label, so a loose match is ambiguous.
    await expect(page.getByText('Ada Okafor', { exact: true })).toBeVisible();
    await expect(page.getByText('No ID uploaded yet.')).toBeVisible();

    // A director's ID goes to that director, not into a generic pile.
    await page.getByLabel("Ada Okafor's ID document").setInputFiles({
      name: 'director-id.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e fixture'),
    });
    await page.getByRole('button', { name: "Upload Ada Okafor's ID" }).click();
    await expect(page.getByText('No ID uploaded yet.')).toHaveCount(0);

    // Company documents are their own tab now — with both halves
    // stacked this was the longest screen in the console.
    await page.getByRole('tab', { name: 'Company documents' }).click();

    // Every section starts outstanding, which the old UI could not show.
    await expect(page.getByText('Not supplied yet.').first()).toBeVisible();

    // A company-level document needs no director.
    await page.getByLabel('Tax certificate file').setInputFiles({
      name: 'tax-cert.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e fixture'),
    });
    await page.getByRole('button', { name: 'Upload Tax certificate' }).click();

    await expect(page.getByText('submitted', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
