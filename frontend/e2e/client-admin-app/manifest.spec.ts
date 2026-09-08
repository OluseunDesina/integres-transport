import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { findTripCarryingPassengers } from '../fixture-lookup';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';

/** The **prepaid open-seating** fixture. `seed_e2e_users` seeds a paid
 * booking with an issued ticket on it (`_seed_boardable_open_seating_ticket`),
 * so this trip's manifest is guaranteed to have at least one row on a
 * freshly seeded database — unlike the reservation route, whose rows
 * only exist once some other spec has booked on it. */
const PREPAID_ROUTE = 'Yaba → Lekki';

/** The pay-as-you-go fixture. */
const PAYG_ROUTE = 'CBD Loop';

/** The trips list is scoped to the active Business, and the one that
 * auto-selects in this dev database has no trips at all — the recorded
 * reason `ui-review-capture` takes an `activeBusinessName`. */
async function selectActiveBusiness(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(EMAIL) }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function accessToken(page: Page): Promise<string> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('integra.auth.session') ?? '{}').accessToken ?? ''
  );
}

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function openManifest(
  page: Page,
  routeName: string,
  options: { payg?: boolean } = {}
): Promise<void> {
  const trip = await findTripCarryingPassengers(
    page.request,
    await accessToken(page),
    routeName,
    options
  );
  await page.goto(`/trips/${trip.id}/manifest`);
  await expect(page.getByRole('heading', { name: 'Trip manifest' })).toBeVisible();
}

test.describe('client-admin-app trip manifest', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('renders an axe-clean manifest for a prepaid departure', async ({ page }) => {
    await openManifest(page, PREPAID_ROUTE);

    await expect(page.getByText(PREPAID_ROUTE)).toBeVisible();
    // Open seating sells places rather than seats, and the cell says so
    // instead of sitting blank.
    await expect(page.getByRole('cell', { name: 'Open seating' }).first()).toBeVisible();
    // The Reference **column**, not the first `BKG-` anywhere: the
    // md:hidden sub-line under the passenger name carries the same
    // string and comes first in the DOM, so `getByText` would assert on
    // an element that is hidden at this width.
    await expect(page.getByRole('cell', { name: /^BKG-[0-9A-Z]{6}$/ }).first()).toBeVisible();
    await expectAxeClean(page);
  });

  test('states the narrowing rather than hiding cancelled rows silently', async ({ page }) => {
    await openManifest(page, PREPAID_ROUTE);

    await expect(page.getByText('Cancelled and expired bookings are hidden')).toBeVisible();

    await page.getByRole('switch', { name: 'Show cancelled bookings' }).click();

    await expect(page.getByText('Cancelled and expired bookings are shown')).toBeVisible();
  });

  test('lists journeys, not an empty booking list, on a pay-as-you-go trip', async ({ page }) => {
    await openManifest(page, PAYG_ROUTE, { payg: true });

    // The defect `kind` exists to prevent: such a trip sells no
    // bookings, so a booking-shaped table would report an empty bus.
    await expect(page.getByRole('columnheader', { name: 'Boarded at' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Reference' })).toHaveCount(0);
    // A journey is not cancellable, so the toggle would mean nothing.
    await expect(page.getByText('Show cancelled bookings')).toHaveCount(0);
    await expectAxeClean(page);
  });

  test('is reachable from the trips list without scheduling.manage', async ({ page }) => {
    await selectActiveBusiness(page, 'Integra E2E Network Test Business');
    await page.goto('/trips');

    // A row link, not an action-menu item: that menu sits entirely
    // behind `scheduling.manage`, and the manifest is gated on
    // `booking.view` — which the Staff preset holds and the other does
    // not.
    const link = page.getByRole('link', { name: /^Manifest for / }).first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/manifest$/);
    await expect(page.getByRole('heading', { name: 'Trip manifest' })).toBeVisible();
  });

  test('downloads the manifest as a CSV named for its trip', async ({ page }) => {
    await openManifest(page, PREPAID_ROUTE);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export this manifest as CSV' }).click();
    await page.getByRole('menuitem', { name: 'CSV' }).click();

    // Not `integra-manifest-all.csv`: five departures downloaded in a
    // row have to be tellable apart.
    expect((await download).suggestedFilename()).toMatch(/^integra-manifest-\d{4}-\d{2}-\d{2}-/);
  });
});
