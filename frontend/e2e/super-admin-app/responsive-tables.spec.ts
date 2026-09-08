import { checkResponsiveTables } from '../responsive-tables';

checkResponsiveTables({
  email: 'e2e-platform-staff@example.com',
  screens: [
    ['kyc-queue', '/kyc-queue'],
    ['kyb-queue', '/kyb-queue'],
    ['businesses', '/businesses'],
  ],
});
