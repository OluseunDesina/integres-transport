import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'Ikeja → CMS';

// From `seed_e2e_users`'s BOOKABLE_* / BOOKABLE_PREMIUM_* constants. The
// two amounts differing is the whole point of this file: a Premium
// departure priced from the wildcard rule would quote 750.
const STANDARD_FARE = 'NGN 750.00';
const PREMIUM_FARE = 'NGN 1250.00';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(PASSENGER_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/**
 * Selects the fixture route by value, matched on a label *prefix* —
 * `trip-search.ts` appends ` — <operator>` once the browse endpoint
 * spans more than one Business, which the tap-and-go fixture guarantees.
 * Same helper booking.spec.ts carries, and for the same recorded reason.
 */
async function selectFixtureRoute(page: Page): Promise<void> {
  const select = page.getByLabel('Route');
  const option = select.locator('option').filter({ hasText: ROUTE_NAME }).first();
  await expect(option).toBeAttached();
  await select.selectOption((await option.getAttribute('value')) ?? '');
}

async function openSearchForm(page: Page): Promise<void> {
  await page.goto('/search');
  await selectFixtureRoute(page);
  await page.getByLabel('From').selectOption({ label: '1. Ikeja' });
  await page.getByLabel('To').selectOption({ label: '3. CMS' });
  await page.getByLabel('Travel date').fill(todayISO());
}

// Serial for the same reason booking.spec.ts is: these tests share the
// fixture route's departures, and one of them reads a seat map.
test.describe.configure({ mode: 'serial' });

test.describe('customer-app service classes', () => {
  test('offers only the classes the route runs, not all four', async ({ page }) => {
    await signIn(page);
    await openSearchForm(page);

    // The seeded route's allow-list is [premium, standard]. Exclusive
    // and Mini exist as classes but this route does not run them, so
    // offering them would produce an empty result that reads as "sold
    // out" rather than "not offered here".
    const options = await page.getByLabel('Class').locator('option').allTextContents();
    expect(options.map((text) => text.trim())).toEqual(['All classes', 'Premium', 'Standard']);
  });

  test('shows both classes unfiltered, and narrows to one when filtered', async ({ page }) => {
    await signIn(page);
    await openSearchForm(page);
    await page.getByRole('button', { name: 'Search' }).click();

    // Counted as "at least one of each" rather than exactly one: this
    // dev database accumulates trips from every previous e2e run (the
    // booking spec's conflict test provisions its own), and an exact
    // count would be red for reasons that have nothing to do with
    // classes. What must hold is that both classes are reachable.
    const cards = page.locator('li').filter({ hasText: ROUTE_NAME });
    // `expect(...).not.toHaveCount(0)` rather than a bare `count()`:
    // count() is a one-shot read with no auto-wait, so it resolves
    // against the pre-search page and reports zero.
    await expect(cards.filter({ hasText: 'Standard' })).not.toHaveCount(0);
    await expect(cards.filter({ hasText: 'Premium' })).not.toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await page.getByLabel('Class').selectOption({ label: 'Premium' });
    await page.getByRole('button', { name: 'Search' }).click();

    // The filter's real contract: nothing that is not Premium survives.
    await expect(cards.filter({ hasText: 'Standard' })).toHaveCount(0);
    await expect(cards.filter({ hasText: 'Premium' })).not.toHaveCount(0);
  });

  test('quotes the Premium fare, not the wildcard one', async ({ page }) => {
    // The assertion this spec exists for (docs/specs/15-trip-classes.md
    // §E2E). A Premium departure priced from the Any-class rule would
    // quote the Standard amount and nothing on screen would say so.
    await signIn(page);
    await openSearchForm(page);
    await page.getByLabel('Class').selectOption({ label: 'Premium' });
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: 'Continue with' }).first().click();

    await expect(page.getByRole('group', { name: 'Seat map' })).toBeVisible();
    // The class the passenger is about to buy, read from the freshly
    // fetched availability envelope rather than from carried state.
    await expect(page.getByText('Premium service')).toBeVisible();
    await expect(page.getByText(PREMIUM_FARE).first()).toBeVisible();
    await expect(page.getByText(STANDARD_FARE)).toHaveCount(0);
  });

  test('carries the class through to the review screen', async ({ page }) => {
    await signIn(page);
    await openSearchForm(page);
    await page.getByLabel('Class').selectOption({ label: 'Premium' });
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: 'Continue with' }).first().click();

    await expect(page.getByRole('group', { name: 'Seat map' })).toBeVisible();
    await page
      .getByRole('group', { name: 'Seat map' })
      .locator('button:not([disabled])')
      .first()
      .click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
    const summary = page.locator('dl').first();
    await expect(summary).toContainText('Service');
    await expect(summary).toContainText('Premium');
    await expect(summary).toContainText(PREMIUM_FARE);

    // Stops here deliberately: nothing is reserved, so this spec leaves
    // no rows behind and stays repeatable against a dev database that
    // keeps everything previous runs wrote.
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
