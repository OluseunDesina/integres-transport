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

test.describe('client-admin-app staff', () => {
  // Serial because two of these tests write the *same* colleague's
  // active flag: one deactivates and reactivates them, the other asserts
  // they are still Active after cancelling a confirmation. Run in
  // parallel they interleave, and the second finds an "Activate" item
  // where it expects "Deactivate" — a flake, not a product defect. Both
  // pass serially, and the whole file takes under a minute.
  test.describe.configure({ mode: 'serial' });

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

  test("changes a colleague's role and active status through confirmed row actions", async ({
    page,
  }) => {
    // Both used to be in-row write controls — a `<select>` that rewrote
    // someone's permissions on change, and a bare checkbox that revoked
    // their access. docs/specs/14 slice 3b made each an explicit,
    // confirmed action.
    await signIn(page);
    await page.goto('/staff');

    function waitForStaffPatch() {
      return page.waitForResponse(
        (res) => res.request().method() === 'PATCH' && res.url().includes('/api/v1/staff/')
      );
    }

    // Nothing writes from the row itself any more.
    const row = page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) });
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('checkbox')).toHaveCount(0);

    // Pick a role the colleague does not already hold. Repeated local
    // runs leave them on whichever role the last run set, and the dialog
    // deliberately refuses to confirm a change that changes nothing.
    const currentRole = (await row.getByRole('cell').nth(1).textContent())?.trim() ?? '';
    const targetRole = currentRole === 'Manager' ? 'Staff' : 'Manager';

    await openRowMenu(page, COLLEAGUE_EMAIL);
    await page.getByRole('menuitem', { name: 'Change role' }).click();

    const roleDialog = page.getByRole('dialog');
    await expect(roleDialog).toBeVisible();
    // Confirming without choosing a different role is refused.
    await expect(roleDialog.getByRole('button', { name: 'Change role' })).toBeDisabled();

    await roleDialog.getByLabel('New role').selectOption({ label: targetRole });
    const [roleResponse] = await Promise.all([
      waitForStaffPatch(),
      roleDialog.getByRole('button', { name: 'Change role' }).click(),
    ]);
    expect(roleResponse.ok()).toBeTruthy();

    await page.reload();
    // The role *cell*, not any text: the colleague's own email contains
    // the word "staff".
    await expect(
      page
        .getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) })
        .getByRole('cell', { name: targetRole, exact: true })
    ).toBeVisible();

    await openRowMenu(page, COLLEAGUE_EMAIL);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    const [activeResponse] = await Promise.all([
      waitForStaffPatch(),
      page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click(),
    ]);
    expect(activeResponse.ok()).toBeTruthy();

    await page.reload();
    await expect(
      page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) }).getByText('Inactive')
    ).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    // Restore active status so repeated local runs of this suite start
    // from the same baseline each time.
    await openRowMenu(page, COLLEAGUE_EMAIL);
    await page.getByRole('menuitem', { name: 'Activate' }).click();
    await Promise.all([
      waitForStaffPatch(),
      page.getByRole('dialog').getByRole('button', { name: 'Activate' }).click(),
    ]);
  });

  test('cancelling the deactivate confirmation writes nothing', async ({ page }) => {
    await signIn(page);
    await page.goto('/staff');

    await openRowMenu(page, COLLEAGUE_EMAIL);
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    await expect(
      page.getByRole('row', { name: new RegExp(COLLEAGUE_EMAIL) }).getByText('Active')
    ).toBeVisible();
  });
});
