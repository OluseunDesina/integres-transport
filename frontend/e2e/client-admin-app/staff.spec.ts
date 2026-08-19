import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const COLLEAGUE_EMAIL = 'e2e-client-staff-colleague@example.com';

function uniqueEmail(): string {
  return `e2e-invite-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('client-admin-app staff', () => {
  test('renders an axe-clean staff screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Staff' }).click();

    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole('heading', { name: 'Staff' })).toBeVisible();
    await expect(page.getByRole('cell', { name: EMAIL, exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('invites a new staff member and shows an in-place success confirmation', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await signIn(page);
    await page.goto('/staff/invite');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Role').selectOption({ label: 'Manager' });
    await page.getByRole('button', { name: 'Send invitation' }).click();

    await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();
    await expect(page).toHaveURL(/\/staff\/invite$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows a field-level error when inviting an email already on staff', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff/invite');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Role').selectOption({ label: 'Manager' });
    await page.getByRole('button', { name: 'Send invitation' }).click();

    await expect(page.getByText('This person is already a member of your team.')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('edits a colleague\'s role and active status inline, persisting after reload', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/staff');

    function waitForStaffPatch() {
      return page.waitForResponse(
        (res) => res.request().method() === 'PATCH' && res.url().includes('/api/v1/staff/')
      );
    }

    const row = page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) });
    const [roleResponse] = await Promise.all([
      waitForStaffPatch(),
      row.getByRole('combobox').selectOption({ label: 'Manager' }),
    ]);
    expect(roleResponse.ok()).toBeTruthy();

    await page.reload();
    const reloadedRow = page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) });
    await expect(reloadedRow.locator('option:checked')).toHaveText('Manager');

    const [activeResponse] = await Promise.all([
      waitForStaffPatch(),
      reloadedRow.getByRole('checkbox').uncheck(),
    ]);
    expect(activeResponse.ok()).toBeTruthy();

    await page.reload();
    const rowAfterDeactivate = page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) });
    await expect(rowAfterDeactivate.getByRole('checkbox')).not.toBeChecked();

    // Restore active status so repeated local runs of this suite start
    // from the same baseline each time.
    await Promise.all([waitForStaffPatch(), rowAfterDeactivate.getByRole('checkbox').check()]);
  });
});
