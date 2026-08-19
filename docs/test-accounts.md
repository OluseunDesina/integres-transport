# Test accounts (local dev only)

Fixed login credentials for local development, so you don't have to
register a new account every time you want to click around. These are
Playwright e2e test fixtures (`seed_e2e_users`) being reused for manual
testing — **not** production or demo data. Every account uses the same
password and exists only in your local Postgres.

Create/refresh them any time the stack is up:

```bash
docker compose up -d postgres redis backend
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py seed_e2e_users
```

Idempotent and safe to rerun — it resets each fixture's status/role, so
a prior manual test session (e.g. approving the KYB queue item) doesn't
leave a later session without something to test against.

## Accounts

| App | Email | Password | Role |
| --- | --- | --- | --- |
| client-admin-app (`:4201`) | `e2e-client-staff@example.com` | `e2e-test-password-123` | Owner — full access (Businesses, Routes, Stops, Staff, KYC, White Label) |
| client-admin-app (`:4201`) | `e2e-client-staff-colleague@example.com` | `e2e-test-password-123` | Staff — narrower permissions, useful for testing access limits |
| customer-app (`:4200`) | `e2e-passenger@example.com` | `e2e-test-password-123` | Passenger |
| super-admin-app (`:4202`) | `e2e-platform-staff@example.com` | `e2e-test-password-123` | Platform staff — KYC/KYB queues, Invite Client |

## Seeded fixture data

Both client-admin accounts belong to **Integra E2E Test Client**, which
owns two Businesses:

- **Integra E2E Network Test Business** — KYB-approved. Use this one for
  Routes/Stops.
- **Integra E2E KYB Review Business** — left in `submitted` status, for
  testing the super-admin KYB review queue.

A separate **Integra E2E KYC Review Client** is seeded permanently in
`submitted` KYC status, for testing the super-admin KYC review queue.

Source: `backend/apps/core/management/commands/seed_e2e_users.py`.
