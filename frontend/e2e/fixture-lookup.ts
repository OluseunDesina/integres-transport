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
