# ADR-0002: Tenancy enforcement mechanism

Status: Accepted — including RLS as defense-in-depth (decided for Phase 1, see below)

## Context

The brief requires cross-client data isolation to be "structurally impossible to forget," not a convention developers remember. Every tenant-owned row carries `client_id`. Isolation must be enforced somewhere that cannot be silently bypassed by a forgotten `.filter(client=...)` call.

## Decision

Phase 0 implements the primary enforcement layer as specified in the brief:

1. **`BaseModel`** (`backend/apps/core/models.py`) — abstract model providing `id` (UUID PK), `client` (FK, nullable only on models that explicitly opt out, e.g. `User` for platform staff), `created_at`, `updated_at`, `deleted_at` (soft delete).
2. **`TenantScopedManager` / `TenantScopedQuerySet`** — the *default* manager on every tenant-owned model. It reads the active client from a thread-local/contextvar set by the tenancy middleware and filters every query by it automatically. There is no "unscoped by default" manager; an explicit `all_objects` manager exists for the narrow cases (super-admin cross-client views) that genuinely need to bypass scoping, so any bypass is `grep`-able by name.
3. **Tenancy middleware** (`backend/apps/core/middleware.py`) — resolves the active Client from the authenticated JWT's `client_id` claim (staff/passenger tokens) or is legitimately absent for platform-staff tokens (`is_platform_staff=True`, see ADR-0003), and sets it in the request-scoped context before any view code runs.
4. A reusable adversarial pytest fixture (`backend/apps/core/tests/tenancy.py`) creates two Clients and asserts that a queryset scoped to Client A never returns Client B's rows, even when queried without an explicit filter. Every future app's test suite is expected to reuse this fixture per model.

## Options considered

- **Manager/middleware filtering only (chosen for Phase 0).** Enforced in the ORM layer, works uniformly regardless of database. Risk: a raw SQL query or a `Model.objects_all.all()` misuse still bypasses it — mitigated by code review discipline and the adversarial test fixture, not by the database itself.
- **Postgres Row-Level Security (RLS) as a second layer (chosen for Phase 1).** The database itself refuses cross-tenant rows regardless of application-layer bugs. Decided now, before Phase 1's `Business`/`KycDocument`/`KybDocument` introduce the first real tenant data — see the "Row-level security" section of `docs/specs/1-identity-client-business.md` for the concrete mechanism (session-variable-scoped policies, `ATOMIC_REQUESTS`, the migration operation every future `BaseModel` subclass must apply, and the registry-driven test that fails closed if a model forgets it).
- **Django-tenant-schemas / separate-schema-per-tenant.** Rejected outright per the brief's locked decision: shared database, shared schema.

## Consequences

Every concrete `BaseModel` subclass — with zero exceptions, including Phase 0's diagnostic `TenancyProbe` — must inherit `BaseModel`, use the default `TenantScopedManager`, **and** apply the RLS migration operation from Phase 1 onward. The registry-driven test (`docs/specs/1-identity-client-business.md`) enumerates every concrete subclass via Django's model registry and fails automatically for any one that skips it — no allowlist, so there is nothing to forget to remove later.

**Load-bearing consequence discovered building Slice 1, not anticipated when this ADR was first written**: RLS is entirely inert against a superuser or `BYPASSRLS`-attributed connection, `FORCE ROW LEVEL SECURITY` notwithstanding — and the docker-compose/CI Postgres setup's `POSTGRES_USER` *is* the initdb bootstrap role, which Postgres refuses to strip `SUPERUSER` from at all. The backend and Celery worker now connect as a separate, ordinary role (`integra_app` — see `docker/postgres/init-role-hardening.sql`), not the bootstrap role (`integra`, still used only to provision that role and extensions). Anyone connecting directly to the dev database with `psql` for anything other than that provisioning should use `integra_app` too, or RLS will look enforced (`pg_class.relrowsecurity`/`relforcerowsecurity` both true) while silently doing nothing for that session.
