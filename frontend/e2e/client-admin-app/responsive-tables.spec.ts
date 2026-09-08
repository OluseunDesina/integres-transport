import type { Page } from '@playwright/test';

import { findTripCarryingPassengers } from '../fixture-lookup';
import { checkResponsiveTables } from '../responsive-tables';

/** The manifest has no fixed URL, and an *empty* trip's manifest renders
 * no table at all — so it must be resolved to a departure that actually
 * carries passengers, or this guard would measure nothing and pass. */
async function manifestPath(page: Page): Promise<string> {
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem('integra.auth.session') ?? '{}').accessToken ?? ''
  );
  const trip = await findTripCarryingPassengers(page.request, token, 'Yaba → Lekki');
  return `/trips/${trip.id}/manifest`;
}

// Every client-admin screen that renders a table — see
// ../responsive-tables.ts for what is measured and why it cannot be a
// unit test.
checkResponsiveTables({
  email: 'e2e-client-staff@example.com',
  activeBusinessName: 'Integra E2E Network Test Business',
  screens: [
    ['routes', '/routes'],
    ['stops', '/stops'],
    ['vehicle-types', '/vehicle-types'],
    ['vehicles', '/vehicles'],
    ['drivers', '/drivers'],
    ['schedules', '/schedules'],
    ['trips', '/trips'],
    ['bookings', '/bookings'],
    ['fares', '/fares'],
    ['tap-go', '/tap-go'],
    ['payments', '/payments'],
    ['ledger', '/ledger'],
    ['businesses', '/businesses'],
    ['staff', '/staff'],
    ['trip-manifest', manifestPath],
  ],
});
