# ADR-0001: Monorepo structure and app/library naming

Status: Accepted

## Context

Integra AFC is one backend serving three white-labeled Angular frontends across three transport verticals. The brief locks in a monorepo containing the backend, all three Angular apps, and shared libraries. This ADR records the concrete directory layout and naming convention chosen for Phase 0, so later phases add apps/libraries consistently rather than inventing structure ad hoc.

## Decision

- Repo root splits into `backend/` (Django project) and `frontend/` (Angular CLI workspace), with `docs/` at the root for specs, ADRs, and self-checks.
- Django apps live under `backend/apps/<name>/`, one app per bounded domain concept, not one giant `core` app. Plural nouns for domain-collection apps (`clients`, `businesses`, `network`), singular for infra/cross-cutting apps (`core`, `identity`, `ledger`).
- `seating` (SeatHold, segment-aware availability) and `booking` (Booking, group booking, reservation orchestration) are deliberately separate apps despite being closely related — they have different lifecycle and query patterns, and keeping them apart matches the fat-services convention (each app's service layer owns one concern).
- `payments` holds the `PaymentProvider` interface plus provider adapters as sub-packages, so Paystack/Flutterwave specifics never leak into `booking` or `wallet`.
- Angular workspace uses `projects/` (Angular CLI workspace, not Nx, per the brief). Three application projects: `customer-app`, `client-admin-app`, `super-admin-app`. Shared libraries: `shared-ui` (presentational components, design tokens), `shared-data` (base signal-store class, list/pagination utilities), `auth` (JWT handling, permissions), `layout` (app-shell primitives, nav), `api-client` (generated OpenAPI TS client). Per-domain feature libraries (`feature-booking`, `feature-fleet`, ...) are created as the phases that need them land — none exist in Phase 0.
- All shared libraries export exclusively through `projects/<lib>/src/public-api.ts` and are consumed via TS path aliases (`@shared-ui`, `@shared-data`, `@auth`, `@layout`, `@api-client`) — never deep relative imports across project boundaries.

## Options considered

- **Nx monorepo** — richer dependency-graph tooling and caching. Rejected: the brief requires matching an existing Angular-CLI-workspace convention (`securepay-mono-repo`-style), and Nx's opinionated structure would fight that.
- **Separate repos per app + backend, versioned API contract between them** — cleaner deploy boundaries. Rejected: the brief explicitly locks in a single monorepo, and cross-repo API contract drift is a worse failure mode for a small team than a slightly larger repo.
- **One flat Django app for all domain models (`core` does everything)** — less boilerplate initially. Rejected: violates fat-services/thin-views at the app level too — a flat app becomes an unreviewable dumping ground by Phase 5, and per-app `INSTALLED_APPS` ordering and migration history stay legible with a domain split from day one.

## Consequences

Adding a new domain concept later means adding a new Django app under `backend/apps/` and, if it needs a UI, a new `feature-<domain>` library under `frontend/projects/`. This is slightly more scaffolding per feature than a monolithic app/library would be, in exchange for enforced separation that makes the "thin vertical slice per module" working agreement mechanically easier to review.
