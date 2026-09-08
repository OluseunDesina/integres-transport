import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('customer-app activity feed', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('is reachable from the home screen', async ({ page }) => {
    await page.goto('/home');
    await page.getByRole('link', { name: 'Activity' }).click();

    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  });

  /**
   * Deliberately does not assert on a specific row: unlike
   * `trip-tracking.spec.ts`, nothing here seeds a *fresh* activity
   * event (doing so needs a completed Paystack charge, which an e2e
   * spec cannot drive — see `apps.activity.services`' own note that
   * every entry ultimately traces to a real `PaymentIntent`, `Ticket`
   * or `FareJourney`). What accumulates from other specs' own seeded
   * flows (`record.spec.ts`, `validate-ticket.spec.ts`, `bookings`)
   * varies run to run, so this asserts the screen's own two valid
   * settled states — populated or genuinely empty — render cleanly
   * either way, the same load-sensitivity `kyc-status.spec.ts`'s own
   * axe check already accepts (docs/traps.md).
   */
  test('renders a populated list or an honest empty state, never an error', async ({ page }) => {
    await page.goto('/activity');

    const list = page.locator('ul li');
    const emptyState = page.getByText('No activity yet');
    await expect(list.first().or(emptyState)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
