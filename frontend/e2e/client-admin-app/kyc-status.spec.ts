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

test.describe('client-admin-app KYC status', () => {
  test('renders an axe-clean KYC status screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'KYC Status' }).click();

    await expect(page).toHaveURL(/\/kyc$/);
    await expect(page.getByRole('heading', { name: 'KYC Status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload document' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('uploads a document, shows it in the list, and status becomes submitted', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/kyc');

    await page.getByLabel('Document type').selectOption({ label: 'Proof of address' });
    await page.getByLabel('File').setInputFiles({
      name: 'proof.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e fixture'),
    });
    await page.getByRole('button', { name: 'Upload document' }).click();

    // .first(): repeated local runs of this test accumulate documents on
    // the shared seeded Client (nothing resets it between runs, unlike
    // the dedicated queue-review Client/Business seed_e2e_users resets) —
    // this only asserts a matching document is present, not that it's
    // the only one.
    await expect(page.getByText('proof_of_address').first()).toBeVisible();
    await expect(page.getByText('submitted', { exact: true })).toBeVisible();

    // The submit button's `disabled:opacity-50` (ui-button) animates back
    // to full opacity over Tailwind's default 150ms `transition` once the
    // upload completes — axe-core can sample mid-transition and report a
    // transient, non-deterministic contrast "violation" on a frame no
    // human ever perceives. Wait for the CSS transition to actually
    // settle before scanning, rather than judging an animating frame.
    await page
      .getByRole('button', { name: 'Upload document' })
      .waitFor({ state: 'visible' });
    await expect(async () => {
      const opacity = await page
        .getByRole('button', { name: 'Upload document' })
        .evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe('1');
    }).toPass({ timeout: 2000 });

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
