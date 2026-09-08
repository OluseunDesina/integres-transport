import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-platform-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
// Seeded by seed_e2e_users.py for the KYC-queue fixtures — a stable,
// already-existing Client.email safe to reuse as the duplicate case here.
const EXISTING_CLIENT_EMAIL = 'e2e-kyc-review@example.com';

function uniqueEmail(): string {
  return `e2e-invite-client-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.com`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('super-admin-app invite a client', () => {
  test('renders an axe-clean invite-client screen behind the nav shell', async ({ page }) => {
    await signIn(page);
    // Scoped to the nav and in sentence case: spec 14 slice 6a matched
    // the labels to their headings, and gave `home` cards linking to the
    // same four destinations — so an unscoped link lookup now matches
    // two elements.
    await page.getByRole('navigation').getByRole('link', { name: 'Invite a client' }).click();

    await expect(page).toHaveURL(/\/invite-client$/);
    await expect(page.getByRole('heading', { name: 'Invite a client' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('invites a new client and shows an in-place success confirmation', async ({ page }) => {
    const email = uniqueEmail();
    await signIn(page);
    await page.goto('/invite-client');
    await page.getByLabel('Business name').fill('E2E Invited Shuttle Co');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send invitation' }).click();

    await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();
    await expect(page).toHaveURL(/\/invite-client$/);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('shows a field-level error when inviting an already-registered email', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/invite-client');
    await page.getByLabel('Business name').fill('Duplicate Attempt Co');
    await page.getByLabel('Email').fill(EXISTING_CLIENT_EMAIL);
    await page.getByRole('button', { name: 'Send invitation' }).click();

    await expect(page.getByText('A client with this email already exists.')).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
