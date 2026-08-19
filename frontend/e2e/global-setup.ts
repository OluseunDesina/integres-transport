import { execSync } from 'node:child_process';

/**
 * Seeds fixed e2e test accounts by shelling into the backend's Django
 * management command. Requires the backend + Postgres to already be up
 * (`docker compose up`), which is the "real running stack" the brief's
 * e2e convention requires — this suite never mocks the API.
 */
export default function globalSetup(): void {
  execSync('docker compose exec -T backend python manage.py seed_e2e_users', {
    cwd: '..',
    stdio: 'inherit',
  });
}
