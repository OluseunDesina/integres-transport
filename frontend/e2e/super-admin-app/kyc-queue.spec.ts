import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-platform-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const SEEDED_CLIENT = 'Integra E2E KYC Review Client';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// Serial: the seeded queue has exactly one row, and only the final test
// here actually decides it (removing it from the queue) — the earlier
// tests must run first while it's still reviewable.
test.describe.configure({ mode: 'serial' });

test.describe('super-admin-app KYC queue', () => {
  test('renders an axe-clean KYC queue behind the nav shell', async ({ page }) => {
    await signIn(page);
    // Scoped to the nav and in sentence case: spec 14 slice 6a matched
    // the labels to their headings, and gave `home` cards linking to the
    // same four destinations — so an unscoped link lookup now matches
    // two elements.
    await page.getByRole('navigation').getByRole('link', { name: 'KYC queue' }).click();

    await expect(page).toHaveURL(/\/kyc-queue$/);
    await expect(page.getByRole('heading', { name: 'KYC queue' })).toBeVisible();
    await expect(page.getByText(SEEDED_CLIENT)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('rejecting requires a reason, and the open dialog is axe-clean', async ({ page }) => {
    await signIn(page);
    await page.goto('/kyc-queue');

    const row = page.getByRole('row', { name: new RegExp(SEEDED_CLIENT) });
    await row.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const confirmButton = dialog.getByRole('button', { name: 'Approve' });
    await expect(confirmButton).toBeEnabled();

    await dialog.getByLabel('Reject').check();
    const rejectButton = dialog.getByRole('button', { name: 'Reject' });
    await expect(rejectButton).toBeDisabled();

    await dialog.getByLabel('Reason').fill('Missing certificate of incorporation.');
    await expect(rejectButton).toBeEnabled();

    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(results.violations).toEqual([]);

    // Cancel, not confirm — the row must still be reviewable by the next test.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
  });

  test('is dismissible with Escape, restoring focus to the row that opened it', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/kyc-queue');

    const row = page.getByRole('row', { name: new RegExp(SEEDED_CLIENT) });
    const reviewButton = row.getByRole('button', { name: 'Review' });
    await reviewButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
    // CDK's Dialog service restores focus to the trigger element
    // synchronously on close (restoreFocus: true, the default). The
    // real, previously-undiagnosed bug this masked: the component's own
    // deferred post-close refetch (kyc-queue.ts) used to run
    // unconditionally, including on cancel/Escape — recreating the
    // whole table a moment after focus had just been correctly
    // restored to this exact button, landing focus back on nothing.
    // Fixed by only refetching on an actual decision.
    await expect(reviewButton).toBeFocused();
  });

  test('the decide dialog is fully operable by keyboard alone', async ({ page }) => {
    await signIn(page);
    await page.goto('/kyc-queue');

    const row = page.getByRole('row', { name: new RegExp(SEEDED_CLIENT) });
    await row.getByRole('button', { name: 'Review' }).focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Tab through the dialog's focus-trapped content until the checked
    // "Approve" radio is focused (native radio groups take one Tab stop,
    // landing on the checked item), then move within the group with
    // ArrowDown to reach and select "Reject" — proves the CDK focus trap
    // actually contains real, reachable interactive controls, not just
    // that Escape closes it.
    const approveRadio = dialog.getByLabel('Approve');
    const rejectRadio = dialog.getByLabel('Reject');
    for (let i = 0; i < 8 && !(await approveRadio.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(approveRadio).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rejectRadio).toBeFocused();
    await expect(rejectRadio).toBeChecked();

    const reasonField = dialog.getByLabel('Reason');
    for (let i = 0; i < 8 && !(await reasonField.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(reasonField).toBeFocused();
    await page.keyboard.type('Missing certificate of incorporation.');

    const cancelButton = dialog.getByRole('button', { name: 'Cancel' });
    for (let i = 0; i < 8 && !(await cancelButton.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(cancelButton).toBeFocused();
    await page.keyboard.press('Enter');

    // Cancel, not confirm — the row must still be reviewable by the next test.
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
  });

  test('approves the submission, removing it from the queue', async ({ page }) => {
    await signIn(page);
    await page.goto('/kyc-queue');

    const row = page.getByRole('row', { name: new RegExp(SEEDED_CLIENT) });
    await row.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Approve' }).click();

    await expect(dialog).not.toBeVisible();
    // Scoped to this row, not "No submissions to review" — the queue can
    // legitimately hold other Clients' submissions at the same time (in
    // production, and in practice here too: client-admin-app's own e2e
    // suite submits real KYC documents against a separate shared Client,
    // which independently surfaces in this same queue). Asserting the
    // whole queue empties assumes something the product doesn't.
    await expect(row).not.toBeVisible();
  });
});
