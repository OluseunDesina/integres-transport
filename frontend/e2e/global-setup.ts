import { execSync } from 'node:child_process';

/**
 * Seeds fixed e2e test accounts by shelling into the backend's Django
 * management command. Requires the backend + Postgres to already be up
 * (`docker compose up`), which is the "real running stack" the brief's
 * e2e convention requires — this suite never mocks the API.
 */
export default function globalSetup(): void {
  // Escape hatch for running against a backend started outside Docker.
  // The committed backend image can lag the dependency list (CLAUDE.md
  // records `docker compose build backend` timing out on `pynacl` /
  // `django-celery-beat` wheels), and the documented workaround is to
  // run `uv run python manage.py runserver` directly against the
  // `postgres`/`redis` containers — at which point there is no backend
  // container for this to exec into, and globalSetup fails before a
  // single test runs. Seed via the same management command yourself,
  // then set E2E_SKIP_SEED=1.
  if (process.env['E2E_SKIP_SEED']) {
    return;
  }
  execSync('docker compose exec -T backend python manage.py seed_e2e_users', {
    cwd: '..',
    stdio: 'inherit',
  });
}
