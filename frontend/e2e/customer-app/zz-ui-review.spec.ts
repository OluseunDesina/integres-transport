import { expect, type Page } from '@playwright/test';

import { captureUiReview } from '../ui-review-capture';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Drives the booking flow far enough to photograph a screen that has no
 * URL of its own.
 */
async function search(page: Page, tripClass?: string): Promise<void> {
  await page.goto('/search');
  await page.getByLabel('From').fill('Ikeja');
  await page.getByLabel('To').fill('CMS');
  await page.getByLabel('Travel date').fill(todayISO());
  if (tripClass) {
    await page.getByLabel('Class').selectOption({ label: tripClass });
  }
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('button', { name: 'Continue with' }).first()).toBeVisible();
}

/**
 * The id of any paid Booking this passenger holds, so the ticket screen
 * can be photographed.
 *
 * Reads the access token out of the app's own `localStorage` rather than
 * signing in again — `@auth`'s `AuthStore` persists the session there,
 * and the harness has already signed in by the time a flow runs.
 */
async function findPaidBookingId(page: Page): Promise<string> {
  await page.goto('/my-bookings');
  const token = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const raw = localStorage.getItem(localStorage.key(index) as string);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.accessToken === 'string') return parsed.accessToken as string;
      } catch {
        // Not JSON — some other key.
      }
    }
    return null;
  });
  if (!token) {
    throw new Error('No access token in localStorage — did the harness sign in?');
  }

  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const body = await page.evaluate(
      async ([url, bearer]) => {
        const response = await fetch(url as string, {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        return response.json();
      },
      [
        `http://localhost:8000/api/v1/bookings/mine/?limit=${limit}&offset=${offset}`,
        token,
      ] as const
    );
    const paid = (body.results as { id: string; status: string }[]).find(
      (booking) => booking.status === 'paid'
    );
    if (paid) {
      return paid.id;
    }
    if (offset + limit >= body.count) {
      throw new Error('No paid Booking for the e2e passenger — nothing to photograph tickets for.');
    }
  }
}

async function openSeatPicker(page: Page, tripClass?: string): Promise<void> {
  await search(page, tripClass);
  await page.getByRole('button', { name: 'Continue with' }).first().click();
  await expect(page.getByRole('group', { name: 'Seat map' })).toBeVisible();
}

// Skipped unless UI_REVIEW_DIR is set — see ../ui-review-capture.ts.
captureUiReview({
  email: 'e2e-passenger@example.com',
  screens: [
    ['login', '/login'],
    ['home', '/home'],
    ['search', '/search'],
    ['my-bookings', '/my-bookings'],
    ['wallet', '/wallet'],
    ['credentials', '/credentials'],
    // Added for the responsive-tables slice: both render tables that
    // slice re-tiered, and neither had ever been photographed.
    ['journeys', '/journeys'],
    ['payments', '/payments'],
    // Spec 17 slice 3. `report-issue` is photographed empty here; the
    // booking-entry variant, which renders a different form, is a flow
    // below because it needs a booking id.
    ['my-reports', '/my-reports'],
    ['report-issue', '/report-issue'],
  ],
  // The two booking-flow screens read their subject from router state
  // and bounce to /search when it is absent, so they have never been in
  // a capture set despite being half the flow this slice rebuilt.
  flows: [
    { name: 'seat-picker', walk: openSeatPicker },
    {
      name: 'booking-confirm',
      walk: async (page) => {
        await openSeatPicker(page);
        await page.getByRole('group', { name: 'Seat map' }).getByRole('button').first().click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
      },
    },
    // Added for spec 15 slice 3. `search` on its own photographs an
    // empty form, so the class pills — the whole visible surface of this
    // slice on that screen — were not in the capture set at all.
    { name: 'search-results', walk: (page) => search(page) },
    // The reworked From/To suggestion combobox (docs/specs/4-fares-
    // seating-booking-frontend.md §3.3) never had a capture at all —
    // `search` on its own only shows the closed inputs.
    {
      name: 'search-suggestions',
      walk: async (page) => {
        await page.goto('/search');
        await page.getByLabel('From').fill('a');
        await expect(page.getByRole('listbox').first()).toBeVisible();
      },
    },
    { name: 'seat-picker-premium', walk: (page) => openSeatPicker(page, 'Premium') },
    {
      name: 'booking-confirm-premium',
      walk: async (page) => {
        await openSeatPicker(page, 'Premium');
        await page.getByRole('group', { name: 'Seat map' }).getByRole('button').first().click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
      },
    },
    {
      // The booking-entry form: no operator picker, a named trip
      // instead. A different screen from `/report-issue` on its own,
      // and the one a passenger is most likely to reach.
      name: 'report-issue-from-booking',
      walk: async (page) => {
        const bookingId = await findPaidBookingId(page);
        await page.goto(`/report-issue?booking=${bookingId}`);
        await expect(page.getByRole('heading', { name: 'Report an issue' })).toBeVisible();
        await expect(page.getByText('Reporting a problem with')).toBeVisible();
      },
    },
    {
      // Resolved through the API rather than by clicking through
      // my-bookings: this passenger's list runs to hundreds of rows,
      // newest first, so every paid fixture sits many pages deep and a
      // UI walk would be paging for its own sake. Same reasoning as
      // `fixture-lookup.ts` — never trust page 1 of a list this
      // dev database keeps growing.
      name: 'booking-tickets',
      walk: async (page) => {
        const bookingId = await findPaidBookingId(page);
        await page.goto(`/my-bookings/${bookingId}/tickets`);
        await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
      },
    },
  ],
});
