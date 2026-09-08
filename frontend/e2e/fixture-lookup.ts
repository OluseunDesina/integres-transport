import type { APIRequestContext } from '@playwright/test';

/**
 * Lookups against the seeded fixtures that must not assume the fixture
 * is on the first page of a list endpoint.
 *
 * Not a `.spec.ts`, so `playwright.config.ts`'s per-project
 * `testMatch` patterns never pick it up as a test file.
 *
 * Every list endpoint here is paginated and none of them offers a
 * filter narrow enough to pin a single fixture row, so a bounded
 * `?limit=N` fetch plus `.find()` silently returns `undefined` the
 * moment accumulated test data pushes the fixture past N. That failed
 * as `Cannot read properties of undefined (reading 'id')` several
 * frames later, naming nothing useful — which is exactly why it is
 * worth a shared helper rather than a slightly larger `limit`.
 */

const BACKEND_URL = 'http://localhost:8000';

export interface FixtureVehicle {
  id: string;
  registration_number: string;
}

/** Pages `GET /vehicles/` until `registration` turns up, throwing a
 * message that names the missing fixture if it never does. */
export async function findVehicleByRegistration(
  api: APIRequestContext,
  token: string,
  registration: string
): Promise<FixtureVehicle> {
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await (
      await api.get(`${BACKEND_URL}/api/v1/vehicles/?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const match = (page.results as FixtureVehicle[]).find(
      (vehicle) => vehicle.registration_number === registration
    );
    if (match) {
      return match;
    }
    if (offset + limit >= page.count) {
      throw new Error(`Fixture vehicle ${registration} not found — is seed_e2e_users up to date?`);
    }
  }
}

export interface FixtureRoute {
  id: string;
  name: string;
  stops: { id: string; name: string }[];
}

/**
 * Pages `GET /routes/browse/` until `name` turns up.
 *
 * `bookings.spec.ts` used to take page 1 and `.find()`, which returned
 * `undefined` once accumulated e2e routes pushed the fixture past it and
 * failed several frames later as
 * `Cannot read properties of undefined (reading 'stops')` — the
 * known-red recorded against that spec. Same bounded-fetch family as
 * `findVehicleByRegistration` above.
 */
export async function findBrowseRouteByName(
  api: APIRequestContext,
  token: string,
  name: string
): Promise<FixtureRoute> {
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await (
      await api.get(`${BACKEND_URL}/api/v1/routes/browse/?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const match = (page.results as FixtureRoute[]).find((route) => route.name === name);
    if (match) {
      return match;
    }
    if (offset + limit >= page.count) {
      throw new Error(`Fixture route ${name} not found — is seed_e2e_users up to date?`);
    }
  }
}

export interface FixtureTrip {
  id: string;
  route: { id: string; name: string };
}

/**
 * A trip on a named route that **actually has passengers on it**.
 *
 * Resolved through the rows themselves rather than through
 * `GET /trips/`, and that is the whole point. Picking a trip by route
 * and date gives an *empty* departure most of the time — `seed_e2e_users`
 * creates a fresh trip per run on each fixture route, while the seeded
 * booking and the accumulated tap history sit on older ones. A manifest
 * spec pointed at an empty trip passes its navigation assertions and
 * proves nothing about the table.
 *
 * `payg` switches the source, because the two kinds are populated by
 * different models — which is the same fact the manifest's own `kind`
 * exists to state.
 */
export async function findTripCarryingPassengers(
  api: APIRequestContext,
  token: string,
  routeName: string,
  { payg = false }: { payg?: boolean } = {}
): Promise<FixtureTrip> {
  const path = payg ? 'fare-journeys/' : 'bookings/';
  // **Not `?status=paid`.** A ticket is issued at payment and the
  // booking *completes* once that ticket is boarded — so the seeded
  // open-seating fixture, which is deliberately boarded, reads
  // `completed` and a paid-only filter finds nothing on its route. Both
  // statuses have tickets; the ones that do not are exactly the ones a
  // manifest would show as an empty table.
  const ticketed = new Set(['paid', 'completed']);
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await (
      await api.get(`${BACKEND_URL}/api/v1/${path}?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const match = (page.results as { trip: FixtureTrip; status?: string }[]).find(
      (row) =>
        row.trip.route.name === routeName && (payg || ticketed.has(row.status ?? ''))
    );
    if (match) {
      return match.trip;
    }
    if (offset + limit >= page.count || page.results.length === 0) {
      throw new Error(
        `No ${payg ? 'journey' : 'ticketed booking'} on route ${routeName} — is ` +
          `seed_e2e_users up to date?`
      );
    }
  }
}
