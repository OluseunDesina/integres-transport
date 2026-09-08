import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('client-admin-app white label', () => {
  test('renders an axe-clean white-label screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'White label' }).click();

    await expect(page).toHaveURL(/\/white-label$/);
    await expect(page.getByRole('heading', { name: 'White label', exact: true })).toBeVisible();
    // `exact`: the form section is a named landmark ("Custom domain"),
    // so a substring match would find the region as well as the input.
    await expect(page.getByLabel('Domain', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits a field and saves, and the change persists after reload', async ({ page }) => {
    await signIn(page);
    await page.goto('/white-label');

    // The seeded Client's WhiteLabelConfig is lazily created on first GET
    // with an empty `domain` (backend has no default for it) — fill it
    // in alongside the field under test so the required-field validator
    // doesn't block the save.
    const senderName = `E2E Sender ${Date.now()}`;
    await page.getByLabel('Domain', { exact: true }).fill(`e2e-${Date.now()}.example.com`);
    await page.getByLabel('Email sender name').fill(senderName);
    await page.getByRole('button', { name: 'Save changes' }).click();

    // One consistent success treatment across every form now, rather
    // than a bare span in whichever green the screen happened to pick.
    await expect(page.getByText('White label settings saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Email sender name')).toHaveValue(senderName);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
