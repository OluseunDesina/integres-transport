import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'Yaba → Lekki';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(PASSENGER_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** By value on a label *prefix*, for the reason `booking.spec.ts`'s own
 * helper documents: `trip-search.ts` appends the operator name to every
 * option once the browse endpoint spans more than one Business, which
 * these fixtures guarantee. */
async function selectFixtureRoute(page: Page): Promise<void> {
  const select = page.getByLabel('Route');
  const option = select.locator('option').filter({ hasText: ROUTE_NAME }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value')) ?? '');
}

/**
 * The open-seating purchase — docs/specs/10-booking-modes.md slice 4.
 *
 * The combination the spec exists for: pay up front for an origin and
 * destination, and sit anywhere. No seat map is offered, and no seat is
 * chosen; the passenger says how many places they want.
 *
 * Stops at `pending_payment`, where `booking.spec.ts`'s reservation
 * flow also stops and for the same reason — paying leaves the app for
 * Paystack, which no browser test can complete. The other half of the
 * spec's requirement, scanning the resulting seatless ticket, is
 * covered by `validator-app/validate-ticket.spec.ts` against a Ticket
 * `seed_e2e_users` issues directly.
 */
test.describe('customer-app open seating', () => {
  test('buys places instead of seats, and is charged per passenger', async ({ page }) => {
    await signIn(page);

    await page.goto('/search');
    await selectFixtureRoute(page);
    await page.getByLabel('From').selectOption({ label: '1. Yaba' });
    await page.getByLabel('To').selectOption({ label: '3. Lekki' });
    await page.getByLabel('Travel date').fill(todayISO());
    await page.getByRole('button', { name: 'Search' }).click();

    await page.getByRole('button', { name: 'Continue with' }).first().click();

    // The load-bearing difference: no seat map at all, and a different
    // question asked in its place.
    await expect(page.getByRole('heading', { name: 'How many passengers?' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Seat map' })).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await page.getByLabel('Passengers').selectOption('2');
    // The fixture fare is 900.00, so two places is 1800.00 — asserting
    // the arithmetic, not just that a total appeared.
    await expect(page.getByText('NGN 1800.00')).toBeVisible();

    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
    // A passenger count, never an empty "Seats" row — nothing was
    // assigned, and a blank would read as a rendering fault.
    await expect(page.getByText('Passengers')).toBeVisible();
    await expect(page.getByText('Seats', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Reserve places' }).click();

    await expect(page).toHaveURL(/\/my-bookings$/);
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();
    // toContainText, not getByText: the status pill renders in both
    // responsive tiers (the md:hidden sub-line and the md:table-cell
    // column), so a text locator is a strict-mode violation — the
    // same duplication the responsive-tables slice already hit.
    await expect(row).toContainText('Pending payment');

    // Left cancelled rather than pending, so repeated runs do not leave
    // a growing pile of unpaid bookings on the fixture trip.
    // Cancel lives in the row's action menu since spec 14 slice 5.
    await row.getByRole('button', { name: 'Actions for' }).click();
    await page.getByRole('menuitem', { name: 'Cancel booking' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(row).toContainText('Cancelled');
  });
});
