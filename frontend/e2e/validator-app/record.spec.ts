import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'e2e-client-staff@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'CBD Loop';
const BOARD_STOP = 'Gate A';
const ALIGHT_STOP = 'Gate B';
// Seeded directly by seed_e2e_users (apps/core/management/commands/
// seed_e2e_users.py::_seed_tap_and_go_fixture) — the raw token is never
// persisted by the real issuance flow, so this constant only exists so
// the fixture and this spec agree on the same value.
const TOKEN = 'e2e-tap-credential-fixed-token';

// The bookable fixture's route, which is prepaid — seeded for today
// among others, so it is in this picker too as of
// docs/specs/10-booking-modes.md's universal tap.
const PREPAID_ROUTE_NAME = 'Ikeja → CMS';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/record$/);
}

/**
 * Picks a trip by route name rather than by index. The picker lists
 * both fare collection modes now, and this dev/CI database seeds
 * several routes for today — an index would silently select whichever
 * trip happens to depart earliest.
 */
async function selectTripByRoute(page: Page, routeName: string): Promise<void> {
  const select = page.getByLabel('Trip');
  const option = select.locator('option', { hasText: routeName }).first();
  await expect(option).toBeAttached();
  await select.selectOption(await option.getAttribute('value'));
}

function waitForTapPost(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/taps/')
  );
}

test.describe('validator-app record-tap', () => {
  test("renders an axe-clean screen listing today's trips in both fare modes", async ({
    page,
  }) => {
    await signIn(page);

    const tripOptions = page.getByLabel('Trip').locator('option');
    // Both modes, because a tap credential is universal fare media —
    // filtering either out would make one of its two meanings
    // unreachable from this screen. Counted as "at least one", not
    // exactly one: this dev/CI database accumulates duplicate trips on
    // the bookable route from every earlier e2e run.
    await expect(tripOptions.filter({ hasText: ROUTE_NAME }).first()).toBeAttached();
    await expect(tripOptions.filter({ hasText: PREPAID_ROUTE_NAME }).first()).toBeAttached();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // Board then alight in one test so the fixture's one-open-journey-
  // per-(business, passenger) invariant is never left open across runs
  // — see this spec file's own note below for the one accepted gap
  // this doesn't cover.
  test('records a board tap then an alight tap, closing the fare journey', async ({ page }) => {
    await signIn(page);

    await selectTripByRoute(page, ROUTE_NAME);
    await expect(page.getByLabel('Stop').locator('option')).toHaveCount(4);

    await page.getByLabel('Tap credential (scan or type)').fill(TOKEN);
    // Radios now, not toggle buttons: the control was a
    // `role="radiogroup"` div wrapping two `ui-button`s with
    // `aria-pressed`, which announced as a radio group and behaved as
    // two independent toggles (spec 14 slice 6b). `exact: true` because
    // "Board" would otherwise substring-match the submit button's own
    // dynamic label, "Record board tap".
    await expect(page.getByRole('radio', { name: 'Board', exact: true })).toBeChecked();
    await page.getByLabel('Stop').selectOption({ label: BOARD_STOP });

    const [boardResponse] = await Promise.all([
      waitForTapPost(page),
      page.getByRole('button', { name: 'Record board tap' }).click(),
    ]);
    expect(boardResponse.ok()).toBeTruthy();
    // `status`, not `alert`: a success is announced politely now.
    // `role="alert"` is assertive and interrupts a screen reader
    // mid-sentence, which is right for a failure and wrong for a
    // confirmation (docs/specs/14 slice 4).
    // "in progress", not the raw `open` enum.
    await expect(page.getByRole('status')).toContainText('Recorded. Journey in progress');
    await expect(page.getByLabel('Tap credential (scan or type)')).toHaveValue('');

    // Clicked by its label, which is what a user does: the segmented
    // variant's input is `sr-only` and sits underneath the label that
    // covers it, so a click aimed at the input itself is intercepted.
    // The input is still focusable and arrow-selectable — `sr-only`
    // hides it visually without removing it from the tab order, which
    // is the whole reason the variant is built this way.
    await page.getByText('Alight', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Alight', exact: true })).toBeChecked();
    await page.getByLabel('Tap credential (scan or type)').fill(TOKEN);
    await page.getByLabel('Stop').selectOption({ label: ALIGHT_STOP });

    const [alightResponse] = await Promise.all([
      waitForTapPost(page),
      page.getByRole('button', { name: 'Record alight tap' }).click(),
    ]);
    expect(alightResponse.ok()).toBeTruthy();
    await expect(page.getByRole('status')).toContainText('Recorded. Journey complete');
    // "NGN 300.00", not "300.00 NGN" — this app rendered money in the
    // opposite order from every other screen until `formatMoney` moved
    // into @shared-ui.
    await expect(page.getByRole('status')).toContainText('NGN 300.00');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * The prepaid half of the universal tap — docs/specs/10-booking-modes.md
   * slice 3. What this pins down is the *branch*: the same credential,
   * on a prepaid trip, goes to ticket validation rather than opening a
   * fare journey, and the two pay-as-you-go questions disappear because
   * a prepaid passenger's journey was fixed when they bought it.
   *
   * It deliberately does **not** assert a status code. The fixture
   * credential's passenger accumulates real bookings on this shared
   * route across runs and manual verification, so whether a tap finds
   * no ticket (404), a boardable one (200) or an already-boarded one
   * (409) depends on this database's history — pinning one would be a
   * flake dressed up as an assertion. Boarding a known-fresh ticket
   * needs a paid-booking fixture, which arrives with slice 4's
   * open-seating purchase spec.
   */
  test('validates a ticket instead of opening a journey on a prepaid trip', async ({ page }) => {
    await signIn(page);

    await selectTripByRoute(page, PREPAID_ROUTE_NAME);

    await expect(page.getByText('Prepaid')).toBeVisible();
    await expect(page.getByLabel('Stop')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Board', exact: true })).toHaveCount(0);

    const tapPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/taps/')) {
        tapPosts.push(request.url());
      }
    });

    await page.getByLabel('Tap credential (scan or type)').fill(TOKEN);
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/tickets/validate/')
      ),
      page.getByRole('button', { name: 'Board ticket' }).click(),
    ]);

    expect(response.url()).toContain('/tickets/validate/');
    // The whole point: no fare journey is opened on a prepaid trip.
    expect(tapPosts).toEqual([]);
    // Whatever the backend decided, the operator is told — success
    // politely (`status`), failure assertively (`alert`).
    await expect(page.getByRole('status').or(page.getByRole('alert')).first()).not.toBeEmpty();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  // Not covered here, deliberately: if a previous run of the test above
  // is interrupted between the board and alight steps, the next run's
  // board tap 409s (OpenJourneyExists) — seed_e2e_users has no way to
  // force-close a stray open FareJourney the way it force-resets KYC/
  // KYB status. Accepted, same class of "assumes the previous run
  // finished cleanly" limitation as this codebase's other e2e fixtures.
});
