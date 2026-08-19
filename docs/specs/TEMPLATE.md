# <Phase>-<Module>: <Title>

## Scope and non-goals

What this module covers. What it explicitly does not cover (deferred to a later phase/module).

## Data model changes

New models, fields, migrations. Note whether any migration is destructive (requires explicit approval before running).

## API surface

Endpoints added/changed: method, path, request/response shape, auth requirements, rate limits.

## Edge cases

Enumerate the non-happy-path inputs/states this module must handle correctly.

## Failure modes

What can go wrong (network, concurrency, partial writes) and how the module behaves when it does.

## Test plan

Backend: models/services/endpoints to cover, including any of the mandatory cross-cutting tests (cross-client isolation, concurrency, ledger invariants, idempotency, webhook replay) that apply to this module.
Frontend: components/stores to cover.
E2E: user flows to cover.

## Migration impact

Additive/backfill/removal steps if schema changes. Explicit call-out if any step is destructive.
