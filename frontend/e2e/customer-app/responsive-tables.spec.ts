import { checkResponsiveTables } from '../responsive-tables';

checkResponsiveTables({
  email: 'e2e-passenger@example.com',
  screens: [
    ['my-bookings', '/my-bookings'],
    ['credentials', '/credentials'],
    ['journeys', '/journeys'],
    ['payments', '/payments'],
    ['wallet', '/wallet'],
  ],
});
