import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

const STAFF_EMAIL = 'e2e-client-staff@example.com';
const PASSENGER_EMAIL = 'e2e-passenger@example.com';
const PASSWORD = 'e2e-test-password-123';
const ROUTE_NAME = 'Yaba → Lekki';
const BACKEND_URL = 'http://localhost:8000';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(STAFF_EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/record$/);
}

async function tokenFor(api: APIRequestContext, audience: string, email: string): Promise<string> {
  const response = await api.post(`${BACKEND_URL}/api/v1/auth/${audience}/token/`, {
    data: { email, password: PASSWORD },
  });
  return (await response.json()).access as string;
}

/**
 * The signed payload of a **seatless** Ticket, fetched through the real
 * passenger-facing endpoints.
 *
 * The Ticket itself is seeded by `seed_e2e_users`, not bought here:
 * paying leaves the app for Paystack, which no browser test can
 * complete. See that command's `_seed_boardable_open_seating_ticket`
 * for why it reseeds whenever the previous run boarded one.
 */
async function seatlessTicketPayload(
  api: APIRequestContext
): Promise<{ payload: string; serviceDate: string }> {
  const token = await tokenFor(api, 'customer', PASSENGER_EMAIL);
  const headers = { Authorization: `Bearer ${token}` };
  const limit = 100;

  for (let offset = 0; ; offset += limit) {
    const page = await (
      await api.get(`${BACKEND_URL}/api/v1/bookings/mine/?limit=${limit}&offset=${offset}`, {
        headers,
      })
    ).json();
    const bookings = page.results as {
      id: string;
      status: string;
      trip: { service_date: string; route: { name: string } };
    }[];
    for (const booking of bookings) {
      if (booking.status !== 'paid' || booking.trip.route.name !== ROUTE_NAME) {
        continue;
      }
      const tickets = await (
        await api.get(`${BACKEND_URL}/api/v1/bookings/${booking.id}/tickets/`, { headers })
      ).json();
      const issued = (tickets.results as { status: string; signed_payload: string }[]).find(
        (ticket) => ticket.status === 'issued'
      );
      if (issued) {
        // The trip's own date, not today's: the seeder targets the next
        // *future* departure, because a Ticket's `expires_at` is
        // anchored to it and cannot precede its own issuance.
        return { payload: issued.signed_payload, serviceDate: booking.trip.service_date };
      }
    }
    if (offset + limit >= page.count) {
      throw new Error(
        `No unboarded ${ROUTE_NAME} ticket found — is seed_e2e_users up to date?`
      );
    }
  }
}

async function selectTripByRoute(page: Page, routeName: string): Promise<void> {
  const select = page.getByLabel('Trip');
  const option = select.locator('option', { hasText: routeName }).first();
  await expect(option).toBeAttached();
  await select.selectOption(await option.getAttribute('value'));
}

/**
 * The first e2e coverage this screen has had — and the scan half of
 * docs/specs/10-booking-modes.md's own end-to-end requirement, whose
 * purchase half lives in `customer-app/open-seating.spec.ts`.
 *
 * What it pins down that a unit test cannot: an open-seating ticket
 * carries no seat, and the validator says so honestly rather than
 * rendering a dangling "seat" label.
 */
test.describe('validator-app validate-ticket', () => {
  test('boards a seatless open-seating ticket', async ({ page }) => {
    const api = await request.newContext();
    let ticket: { payload: string; serviceDate: string };
    try {
      ticket = await seatlessTicketPayload(api);
    } finally {
      await api.dispose();
    }

    await signIn(page);
    await page.getByRole('link', { name: 'Validate ticket' }).click();
    await expect(page).toHaveURL(/\/validate-ticket$/);

    // The date change reloads the trip list asynchronously, and the
    // fixture runs this route at the same time every day — so picking
    // from the previous date's options silently selects a *different*
    // trip with an identical label, which the backend then correctly
    // refuses with "This ticket was not issued for this trip."
    //
    // Polled rather than waited on: `networkidle` can resolve before
    // the reload has even started, and the screen fires two trip
    // requests per load (scheduled and in_progress), so matching one
    // response is a coin flip. Re-selecting each round handles the
    // option list being swapped underneath.
    // Selecting from the stale list also *clears the selection* the
    // moment the new one arrives — the old trip id matches no option —
    // so the poll body must tolerate both the option and the detail
    // line being briefly absent rather than throwing on the first
    // round.
    await page.getByLabel('Service date').fill(ticket.serviceDate);
    const trips = page.getByLabel('Trip');
    await expect
      .poll(
        async () => {
          const option = trips.locator('option', { hasText: ROUTE_NAME }).first();
          if ((await option.count()) === 0) {
            return '';
          }
          await trips.selectOption(await option.getAttribute('value'));
          const detail = page.locator('p', { hasText: ROUTE_NAME }).first();
          return (await detail.count()) === 0 ? '' : ((await detail.textContent()) ?? '');
        },
        { timeout: 15_000 }
      )
      .toContain(ticket.serviceDate);
    await page.getByLabel('Ticket QR payload (scan or paste)').fill(ticket.payload);

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/tickets/validate/')
      ),
      page.getByRole('button', { name: 'Validate ticket' }).click(),
    ]);

    expect(response.status()).toBe(200);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('boarded');
    await expect(alert).toContainText('Yaba');
    await expect(alert).toContainText('Lekki');
    // No seat was ever assigned, so the label must be absent rather
    // than trailing an empty value.
    await expect(alert).not.toContainText('seat');

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
