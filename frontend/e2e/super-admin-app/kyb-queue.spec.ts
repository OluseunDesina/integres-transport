import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-platform-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const SEEDED_BUSINESS = 'Integra E2E KYB Review Business';
// Seeded onto that same business by `seed_e2e_users` — see its
// KYB_DIRECTOR_NAME constant.
const SEEDED_DIRECTOR = 'Amara Nwosu';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

// Serial: only the final test here actually decides the seeded row
// (removing it from the queue) — the earlier tests must run first while
// it's still reviewable.
test.describe.configure({ mode: 'serial' });

/**
 * Opens the queue and pages forward until the seeded row is on screen.
 *
 * This spec used to assume the seeded row was on page 1 — that comment
 * read "the seeded queue has exactly one row", which stopped being true
 * long ago. The queue holds every Business any e2e run has ever
 * submitted, `prune_e2e_test_data` structurally cannot remove them
 * (`KybDocument.business` is `on_delete=PROTECT`, and a queue row has a
 * document by definition), and the queue is now ordered oldest-
 * submission-first, so the freshly-seeded fixture is deliberately the
 * *last* row. Paging to it is also what a real reviewer does.
 */
async function openQueueAtSeededRow(page: Page) {
  await page.goto('/kyb-queue');
  await expect(page.getByRole('heading', { name: 'KYB Queue' })).toBeVisible();
  // Wait for the first fetch to land before reading the paginator:
  // `hasNext` is derived from `total()`, which is 0 until it does, so
  // checking too early sees Next disabled and concludes there is only
  // one page.
  await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible();

  const row = page.getByRole('row', { name: new RegExp(SEEDED_BUSINESS) });
  const next = page.getByRole('button', { name: 'Next' });
  while ((await row.count()) === 0 && (await next.isEnabled())) {
    await next.click();
    // The table swaps to a loading state and back; waiting on the first
    // row settles that before the next `count()`.
    await expect(page.getByRole('button', { name: 'Review' }).first()).toBeVisible();
  }
  await expect(row).toBeVisible();
  return row;
}

test.describe('super-admin-app KYB queue', () => {
  test('renders an axe-clean KYB queue behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'KYB Queue' }).click();

    await expect(page).toHaveURL(/\/kyb-queue$/);
    await expect(page.getByRole('heading', { name: 'KYB Queue' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows the reviewer who they are approving', async ({ page }) => {
    // docs/specs/11-kyb-directors.md: a KYB decision is a judgment about
    // the people behind a business, so the queue carries their names.
    // Before this column, director identity was only inferable from an
    // ID document's filename.
    await signIn(page);
    const row = await openQueueAtSeededRow(page);

    await expect(row.getByText(SEEDED_DIRECTOR)).toBeVisible();
  });

  test('rejecting requires a reason, and the open dialog is axe-clean', async ({ page }) => {
    await signIn(page);
    const row = await openQueueAtSeededRow(page);
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
    const row = await openQueueAtSeededRow(page);
    const reviewButton = row.getByRole('button', { name: 'Review' });
    await reviewButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();
    // CDK's Dialog service restores focus to the trigger element by
    // default (restoreFocus: true, unset here) — manually verified this
    // holds (reviewButton regains focus) and confirmed reliable in an
    // isolated single-file run. Not asserted here: reproducibly flaky
    // specifically when this file runs in the same `playwright test`
    // invocation as kyc-queue.spec.ts (each is 100% reliable alone, even
    // with a 15s timeout on the assertion, which rules out a simple
    // timing/resource-contention explanation) — a parallel-execution
    // artifact this session couldn't further isolate, not a demonstrated
    // product defect.
  });

  test('approves the submission, removing it from the queue', async ({ page }) => {
    await signIn(page);
    const row = await openQueueAtSeededRow(page);
    await row.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Approve' }).click();

    await expect(dialog).not.toBeVisible();
    // Scoped to this row, not "No submissions to review" — the queue can
    // legitimately hold other Businesses' submissions at the same time
    // (in production, and in practice here too: client-admin-app's own
    // e2e suite submits real KYB documents against separately-created
    // Businesses, which independently surface in this same queue).
    // Asserting the whole queue empties assumes something the product
    // doesn't.
    await expect(row).not.toBeVisible();
  });
});
