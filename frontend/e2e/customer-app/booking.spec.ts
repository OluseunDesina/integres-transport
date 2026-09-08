import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Locator, type Page } from '@playwright/test';

import { findBrowseRouteByName, findVehicleByRegistration } from '../fixture-lookup';

const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'Ikeja → CMS';
const BACKEND_URL = 'http://localhost:8000';

/**
 * Opens a booking row's action menu and picks Cancel.
 *
 * Cancel moved out of the row's cells and into `ui-action-menu` in spec
 * 14 slice 5 — the cell held a bare checkbox, a breakdown paragraph and
 * up to three buttons, which squeezed the Route column at 390px.
 */
async function openCancelDialog(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: 'Actions for' }).click();
  await page.getByRole('menuitem', { name: 'Cancel booking' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

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

function farFutureISO(): string {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

/**
 * Selects the fixture route by value, matched on a label *prefix*.
 *
 * `selectOption({ label })` matches exactly, and `trip-search.ts`
 * appends ` — <operator>` to every option as soon as the browse
 * endpoint spans more than one Business. The tap-and-go fixture alone
 * guarantees that, so the bare-label form here had been failing since
 * that fixture landed — unnoticed, because this project's e2e suite
 * had not been run since.
 */
async function selectFixtureRoute(page: Page): Promise<void> {
  const select = page.getByLabel('Route');
  const option = select.locator('option').filter({ hasText: ROUTE_NAME }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value')) ?? '');
}

/** Runs the search and returns the "Continue with …" buttons. */
async function runSearch(page: Page, serviceDate: string): Promise<Locator> {
  await page.goto('/search');
  await selectFixtureRoute(page);
  await page.getByLabel('From').selectOption({ label: '1. Ikeja' });
  await page.getByLabel('To').selectOption({ label: '3. CMS' });
  await page.getByLabel('Travel date').fill(serviceDate);
  await page.getByRole('button', { name: 'Search' }).click();
  const options = page.getByRole('button', { name: 'Continue with' });
  await expect(options.first()).toBeVisible();
  return options;
}

/**
 * Opens the seat picker on the first departure that actually has one.
 *
 * **Not simply `.first()`.** The earliest departure on this route each
 * day is a Celery-generated trip from the seeded Schedule, and nothing
 * ever assigns it a vehicle — so it is `not_configured`, has no seats,
 * and opens an empty picker. It is only *in* the results during the
 * morning window before it departs, which is why this passed every
 * afternoon for months and failed at 07:20 while spec 18 slice 1 was
 * being verified. The same "do not trust the first row" lesson
 * `fixture-lookup.ts` already carries, arriving in the search results.
 *
 * The search is re-run per candidate rather than navigating back:
 * `seat-picker` reads its subject from router state, so `goBack()`
 * lands on an empty `/search` rather than restoring the results.
 */
async function searchAndOpenSeatPicker(page: Page, serviceDate: string): Promise<number> {
  const candidates = await (await runSearch(page, serviceDate)).count();
  for (let index = 0; index < candidates; index += 1) {
    const options = await runSearch(page, serviceDate);
    await options.nth(index).click();
    // `expect(...).toBeVisible()`, not `isVisible()`: the latter does
    // not retry, so it answers "no" in the instant before the picker
    // has loaded its availability — and every candidate would then look
    // unbookable. The same non-retrying trap CLAUDE.md records for
    // `locator.count()`.
    const seatMap = page.getByRole('group', { name: 'Seat map' });
    const opened = await expect(seatMap)
      .toBeVisible({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      return index;
    }
  }
  throw new Error(
    `No departure on ${ROUTE_NAME} for ${serviceDate} has a vehicle assigned, so none ` +
      `has a seat map. Is seed_e2e_users up to date?`
  );
}

// Books whichever seat is offered first — the happy-path/keyboard/focus
// tests only need *a* seat, not a specific one, and the fixture's seat
// numbers are stable but their availability isn't (repeated runs may
// have consumed some), so picking the first available one keeps these
// tests robust across reruns.
async function pickFirstAvailableSeat(page: Page): Promise<string> {
  // Filtered to :not([disabled]) — seat-picker.html disables a button
  // when the seat is taken, and this fixture's 6 seats are shared across
  // every test in this file (several may run concurrently), so the
  // positionally-first seat button is not reliably the first *available*
  // one.
  const seatButton = page
    .getByRole('group', { name: 'Seat map' })
    .locator('button:not([disabled])')
    .first();
  const label = await seatButton.getAttribute('aria-label');
  await seatButton.click();
  return label ?? '';
}

// Serial: several tests below share the seeded fixture's single trip and
// its 6 seats (only the 409-conflict test provisions its own trip) — run
// in parallel, they can race each other for the same seat exactly the
// way the dedicated conflict test does deliberately, same reasoning
// kyc-queue.spec.ts's own serial mode documents for its shared queue row.
test.describe.configure({ mode: 'serial' });

test.describe('customer-app booking flow', () => {
  test('searches, books a seat, sees it in my bookings, and cancels it — axe-clean throughout', async ({
    page,
  }) => {
    await signIn(page);

    await searchAndOpenSeatPicker(page, todayISO());
    let results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await pickFirstAvailableSeat(page);
    // "1 seat selected", not "1 seat(s) selected" — slice 5 replaced
    // the parenthesised plural with @shared-ui's own plural() helper.
    await expect(page.getByText('1 seat selected')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
    await expect(page.getByText(ROUTE_NAME)).toBeVisible();
    results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Reserve seats' }).click();

    await expect(page).toHaveURL(/\/my-bookings$/);
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    await expect(row).toBeVisible();
    // toContainText, not getByText: the status pill renders in both
    // responsive tiers (the md:hidden sub-line and the md:table-cell
    // column), so a text locator is a strict-mode violation — the
    // same duplication the responsive-tables slice already hit.
    await expect(row).toContainText('Pending payment');
    results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    const dialog = await openCancelDialog(page, row);
    // toBeVisible() resolves as soon as the dialog is in the DOM with a
    // non-zero box — it does not wait for the CDK dialog's own entrance
    // transition to settle. Checking axe immediately catches the danger
    // button mid-fade (translucent background, blended text colour),
    // which reads as a false-positive contrast violation: live
    // measurement (getComputedStyle at increasing waits) confirms the
    // settled state is solid white-on-red well above 4.5:1, stable by
    // ~100ms. This wait avoids re-flagging that transient frame as a
    // real defect.
    await page.waitForTimeout(200);
    const dialogResults = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(dialogResults.violations).toEqual([]);

    await dialog.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toContainText('Cancelled');
    // The menu is still there, but Cancel is gone from it. It used to
    // disappear entirely, because Cancel and View tickets were its only
    // two items and a cancelled booking offers neither. Spec 17 slice 3
    // added "Report a problem" to every row whatever its status —
    // deliberately, since "the reader would not take my card, so I
    // cancelled" is exactly the story worth reporting.
    await row.getByRole('button', { name: 'Actions for' }).click();
    await expect(page.getByRole('menuitem', { name: 'Report a problem' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Cancel booking' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'View tickets' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('shows an axe-clean empty state when nothing runs on the chosen date', async ({ page }) => {
    await signIn(page);
    await page.goto('/search');
    await selectFixtureRoute(page);
    await page.getByLabel('From').selectOption({ label: '1. Ikeja' });
    await page.getByLabel('To').selectOption({ label: '3. CMS' });
    await page.getByLabel('Travel date').fill(farFutureISO());
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByText('No departures found')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('the search-through-confirm flow is completable by keyboard alone', async ({ page }) => {
    await signIn(page);

    const bookableIndex = await searchAndOpenSeatPicker(page, todayISO());

    await page.goto('/search');
    await selectFixtureRoute(page);
    await page.getByLabel('From').selectOption({ label: '1. Ikeja' });
    await page.getByLabel('To').selectOption({ label: '3. CMS' });
    await page.getByLabel('Travel date').fill(todayISO());
    await page.getByRole('button', { name: 'Search' }).focus();
    await page.keyboard.press('Enter');

    const options = page.getByRole('button', { name: 'Continue with' });
    await expect(options.first()).toBeVisible();
    // The **bookable** departure, not the first one — see
    // `searchAndOpenSeatPicker`'s own note. Discovered by mouse in a
    // throwaway pass above and then driven by keyboard here: what this
    // test proves is that the flow is *completable* by keyboard, not
    // that a vehicle-less trip has a seat map.
    await options.nth(bookableIndex).focus();
    await page.keyboard.press('Enter');

    const seatButton = page
      .getByRole('group', { name: 'Seat map' })
      .locator('button:not([disabled])')
      .first();
    await expect(seatButton).toBeVisible();
    await seatButton.focus();
    await page.keyboard.press('Enter');
    await expect(seatButton).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Continue' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
    await page.getByRole('button', { name: 'Reserve seats' }).focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/my-bookings$/);

    // Clean up via the confirm dialog so this reusable fixture seat isn't
    // permanently consumed by every test run.
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    const dialog = await openCancelDialog(page, row);
    await dialog.getByRole('button', { name: 'Cancel booking' }).click();
  });

  test('the cancel dialog is dismissible with Escape, restoring focus to the row', async ({
    page,
  }) => {
    await signIn(page);
    await searchAndOpenSeatPicker(page, todayISO());
    await pickFirstAvailableSeat(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Reserve seats' }).click();

    await expect(page).toHaveURL(/\/my-bookings$/);
    const row = page.getByRole('row', { name: new RegExp(ROUTE_NAME) }).first();
    const dialog = await openCancelDialog(page, row);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(row).toBeVisible();

    // The booking is still pending_payment (Escape did not confirm) —
    // clean it up for real so the fixture seat is released.
    const reopened = await openCancelDialog(page, row);
    await reopened.getByRole('button', { name: 'Cancel booking' }).click();
  });

  test('a seat taken mid-booking by a concurrent passenger surfaces as a conflict, not a double-booking', async ({
    browser,
  }) => {
    // Fresh trip created directly against the API (not through the UI) so
    // this race never depends on how many of the shared fixture's 6 seats
    // are still free from other tests/runs — same reasoning
    // trips.spec.ts's uniqueSuffix() pattern uses for its own isolation,
    // adapted here because seat/fare configuration has no client-admin UI
    // to drive (docs/specs/4-fares-seating-booking-frontend.md §1).
    const api = await request.newContext();
    const staffToken = (
      await (
        await api.post(`${BACKEND_URL}/api/v1/auth/client-admin/token/`, {
          data: { email: STAFF_EMAIL, password: PASSWORD },
        })
      ).json()
    ).access as string;

    // Paged, like the vehicle lookup below and for the identical
    // reason: this was one unbounded `GET /routes/browse/` plus
    // `.find()`, and accumulated e2e routes (43 against a page size of
    // 25) had pushed the fixture off page 1 — failing as
    // `Cannot read properties of undefined (reading 'stops')`, the exact
    // symptom `findBrowseRouteByName` was written for and which this one
    // call site never adopted.
    const route = await findBrowseRouteByName(api, staffToken, ROUTE_NAME);
    const fromStop = route.stops[0];
    const toStop = route.stops[route.stops.length - 1];

    // Paged, not one bounded `?limit=50` page plus `.find()`: `GET
    // /vehicles/` has no registration filter, and the fixture vehicle is
    // long past the first page (104 vehicles here, `E2E-1234-LA` well
    // outside the first 50). The bounded form failed with an opaque
    // "Cannot read properties of undefined (reading 'id')" rather than
    // anything naming the real cause.
    const vehicle = await findVehicleByRegistration(api, staffToken, 'E2E-1234-LA');

    const serviceDate = new Date();
    serviceDate.setDate(serviceDate.getDate() + 200 + Math.floor(Math.random() * 500));
    const trip = await (
      await api.post(`${BACKEND_URL}/api/v1/trips/`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: {
          route: route.id,
          service_date: serviceDate.toISOString().slice(0, 10),
          departure_time: '09:00:00',
          vehicle: vehicle.id,
        },
      })
    ).json();
    expect(trip.status).toBe('scheduled');

    // Two independent browser contexts, each its own signed-in passenger
    // session, both racing to book the same single seat on the same
    // fresh trip's same segment.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    for (const page of [pageA, pageB]) {
      await page.goto('/login');
      await page.getByLabel('Email').fill(PASSENGER_EMAIL);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/home$/);
    }

    // The seat picker reads its journey from router navigation state, not
    // the URL, so it must be reached the same way the app reaches it —
    // via trip-search's own "Choose seats" click — for each context.
    for (const page of [pageA, pageB]) {
      await page.goto('/search');
      await selectFixtureRoute(page);
      // Stop options are labelled "{sequence}. {name}" (trip-search.ts's
      // toStopOption()), not the bare stop name.
      await page.getByLabel('From').selectOption({ label: `${fromStop.sequence}. ${fromStop.name}` });
      await page.getByLabel('To').selectOption({ label: `${toStop.sequence}. ${toStop.name}` });
      await page.getByLabel('Travel date').fill(serviceDate.toISOString().slice(0, 10));
      await page.getByRole('button', { name: 'Search' }).click();
      await expect(page.getByRole('button', { name: 'Continue with' }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Continue with' }).first().click();
      await expect(page.getByRole('group', { name: 'Seat map' })).toBeVisible();
    }

    const seatButtonA = pageA.getByRole('group', { name: 'Seat map' }).getByRole('button').first();
    const seatButtonB = pageB.getByRole('group', { name: 'Seat map' }).getByRole('button').first();
    await seatButtonA.click();
    await seatButtonB.click();

    await pageA.getByRole('button', { name: 'Continue' }).click();
    await pageB.getByRole('button', { name: 'Continue' }).click();

    const [resultA, resultB] = await Promise.allSettled([
      (async () => {
        await pageA.getByRole('button', { name: 'Reserve seats' }).click();
        await pageA.waitForURL(/\/my-bookings$|\/search\/seats$/);
        return pageA.url();
      })(),
      (async () => {
        await pageB.getByRole('button', { name: 'Reserve seats' }).click();
        await pageB.waitForURL(/\/my-bookings$|\/search\/seats$/);
        return pageB.url();
      })(),
    ]);

    const urls = [resultA, resultB].map((r) => (r.status === 'fulfilled' ? r.value : ''));
    const succeeded = urls.filter((u) => u.includes('/my-bookings'));
    const conflicted = urls.filter((u) => u.includes('/search/seats'));

    // Exactly one context wins the seat; the other is bounced back to the
    // seat picker with the conflict notice — never two bookings for one
    // seat, and never a silent failure with no explanation.
    expect(succeeded.length).toBe(1);
    expect(conflicted.length).toBe(1);

    const loserPage = urls[0].includes('/search/seats') ? pageA : pageB;
    await expect(
      loserPage.getByText('One of the seats you picked was taken while you were booking.')
    ).toBeVisible();

    await contextA.close();
    await contextB.close();
    await api.dispose();
  });
});
