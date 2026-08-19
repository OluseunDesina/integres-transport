# ADR-0003: Primary key strategy and platform-staff user modeling

Status: Accepted

## Context

Two Phase-0-blocking modeling questions needed answers before the first migration: what primary key type tenant-owned rows use, and how Integra platform staff (super-admin users, who have no owning Client) relate to the tenant-scoped `User` model.

## Decision

**Primary keys**: UUID (v4) for every model, including `User`. Rationale: avoids sequential-ID enumeration across tenants on a payments platform, and eases the "spin down / seed / revive" demo workflow (`ASSUMPTION` from the Phase 0 plan) where data may be exported/imported across environments without PK collisions.

**Platform-staff modeling**: one `User` model in `backend/apps/identity`, with:
- `client` — nullable FK to `Client`. Populated for tenant-scoped staff and passengers; `NULL` for platform staff.
- `is_platform_staff` — boolean, `False` by default.
- The tenancy middleware treats a JWT with `is_platform_staff=True` and no `client_id` claim as a **legitimate client-less request**, not an error state — this is the one deliberate, documented exception to "every tenant-owned row carries client_id." `User` itself is intentionally excluded from `TenantScopedManager` filtering for platform-staff rows; tenant-scoped staff/passenger `User` rows are still filtered normally.

Confirmed directly with the product owner during Phase 0 planning (not left as an assumption).

## Options considered

- **Separate `PlatformStaffUser` model/table.** Fully distinct from tenant Users, avoids ever having a nullable `client` FK on `User`. Rejected by product owner: the brief specifies "one Django auth service," and a second parallel user table doubles the auth code path (login, password reset, JWT issuance) for a small, low-volume audience (internal Integra staff).
- **Bigint sequential PKs.** Simpler, smaller index size. Rejected in favor of UUID for the enumeration and demo-data-portability reasons above.

## Consequences

Every future model's factory (`factory_boy`) and every cross-client isolation test must account for `User.client` being nullable — a naive "assert every User has a client" test would be wrong. The tenancy middleware and every place that reads `request.client` must handle the `None` case explicitly for platform-staff requests, not assume a Client always exists once a user is authenticated.
