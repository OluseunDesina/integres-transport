# Self-check — Phase 0 (Foundation) — 2026-08-07

Scope: everything in `docs/specs`'s implicit Phase 0 checklist (see the
approved plan) — monorepo scaffold, Docker Compose, CI, Django tenancy
skeleton + identity/auth, Angular workspace with three apps and shared
libraries, a login→home vertical slice proving JWT-audience auth
end-to-end, Playwright+axe, and this report. No business models exist
yet (Client is a deliberate minimal stand-in — see `docs/adr/0001`) — the
per-module items in §10.2/10.3 that require a business model are marked
**not applicable at this phase**, not skipped silently.

## 10.7 Report table

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Backend convention greps (§10.1) | verified | N/A — Angular-specific greps run against `frontend/` (see below); backend has no analogous grep set in §10.1 beyond `ruff`/`mypy` | |
| `ruff check .` | verified | `All checks passed!` (48 files, then 49 after `conftest.py`) | |
| `mypy .` | verified | `Success: no issues found in 49 source files` | |
| Money = `Decimal` + currency field | not applicable at this phase | — | No money-bearing model exists yet |
| All stored datetimes UTC | verified | `USE_TZ = True`, `TIME_ZONE = "UTC"` in `config/settings/base.py`; no model overrides this | |
| Angular v20 convention greps (§10.1) | verified | All 8 greps (`standalone: true`, `@HostBinding`/`@HostListener`, `*ngIf`/`*ngFor`/`*ngSwitch`, `ngClass`/`ngStyle`, `@Input()`/`@Output()`, `.mutate(`, `*.component.ts`, deep relative imports) returned **zero matches** across `frontend/projects/` | Commands and raw output reproduced in this session's transcript |
| No `any` outside generated schema | verified | `grep -rln ": any\|<any>\|as any" projects/ --include="*.ts" \| grep -v schema.ts` → empty | `api-client/src/lib/schema.ts` itself is generated, not hand-written, and is excluded from lint for the same reason (`projects/api-client/eslint.config.js`) |
| No NgRx | verified | `grep -rn "@ngrx" projects/ package.json` → empty | |
| No hardcoded API URLs | verified | `grep -rln "http://\|https://" --include="*.ts" \| grep -v environment \| grep -v spec` → empty | All URLs live in `src/environments/environment*.ts` per app |
| `OnPush` on every component | verified | Inspected all 13 components (`Button`, `TextField`, `Alert`, `AuthLayout`, `ForbiddenPage`, `App`×3, `Login`×3, `Home`×3) — every one declares `changeDetection: ChangeDetectionStrategy.OnPush` | |
| Shared libs export only via `public-api.ts`, consumed via `@shared-ui`/`@shared-data`/`@auth`/`@layout`/`@api-client` | verified | `tsconfig.json` paths map each alias to `projects/<lib>/src/public-api.ts`; grep for deep relative imports (above) is empty | |
| Reactive forms only, no `ngModel` | verified | `grep -rn "ngModel" projects/ --include="*.html"` → empty; `Login` components use `ReactiveFormsModule` + `FormBuilder` | |
| Tailwind first, Material imports justified | verified | Zero `@angular/material` imports anywhere; CDK (`A11yModule`) was imported in `AuthLayout` and **removed** during this phase's own accessibility fix (see §10.6 log) — currently zero CDK usage too, which is honest for Phase 0's simple screens | |
| Backend `pytest` suite | verified | `23 passed` (was 20, +3 for token-refresh coverage and the throttle-triggering test found missing during this self-check) | `apps/*/tests/`, coverage 94% (`--cov=apps`) |
| Cross-client isolation test | verified | `apps/core/tests/test_tenancy.py` — 7 tests, including PK-guessing adversarial case (`test_client_a_cannot_fetch_client_b_row_by_primary_key`) and a full middleware→context→manager path test via `RequestFactory` | No real business model exists yet, so this runs against `core/tests/testapp`'s diagnostic `TenancyProbe` model (see `docs/adr/0002`) — will re-run against a real model once one exists in Phase 1 |
| Concurrent seat booking | not applicable at this phase | — | No seat/booking model exists yet — Phase 4 |
| Segment-aware availability | not applicable at this phase | — | Phase 4 |
| Ledger invariant | not applicable at this phase | — | Phase 5 |
| Payment idempotency | not applicable at this phase | — | Phase 5 |
| Webhook replay | not applicable at this phase | — | Phase 5 |
| Seat-hold expiry | not applicable at this phase | — | Phase 4 |
| OpenAPI spec regenerates with no diff | verified | `backend/scripts/check_openapi_drift.sh` → `OpenAPI schema matches committed openapi.yaml.` | Also frontend-side: `frontend/scripts/check-openapi-drift.sh` → `api-client schema.ts matches backend/openapi.yaml.` |
| Every endpoint has a test | verified | `health`, `readiness`, all 3 token-obtain endpoints, `token/refresh/`, `me/` all have dedicated tests. `admin/`, `schema/`, `docs/` are framework-provided, not application endpoints | Token-refresh test was **missing** until this self-check — added (`test_token_refresh_issues_a_new_access_token_carrying_the_same_custom_claims`, `test_token_refresh_rejects_an_invalid_refresh_token`) |
| Playwright e2e (§10.3) | verified | `11 passed (36.0s)` — real stack (Docker backend + Postgres + Redis + the actual Angular dev servers), not mocked | Login (empty/validation-error/wrong-credentials/success) + Home for all 3 apps; negative path (wrong-audience login) covered per-app; keyboard-only completion covered for customer-app |
| Trace/screenshot artifacts | verified | `frontend/playwright-report/` (HTML report, `trace: retain-on-failure` — none retained since nothing failed in the final run); UI-review screenshots at `docs/ui-review/phase-0-foundation/baseline/` | |
| Accessibility — axe on every screen (§10.4) | verified | `expect(results.violations).toEqual([])` asserted after every meaningful state in all 3 e2e specs; **2 real violations found and fixed** during this phase (see §10.6 log below), zero remaining | |
| Keyboard-only completion | verified | `customer-app login.spec.ts › is completable by keyboard alone` — tab-through + Enter submit, no mouse | Only asserted for customer-app; client-admin/super-admin share the identical `Login` component structure so the risk of a per-app regression here is low but **unverified** by a dedicated test for those two |
| Visible focus states | verified by inspection | `TextField` and `Button` both use `focus-visible:outline` Tailwind utilities, not the browser default (which axe doesn't check but a11y review does) | Not captured as a dedicated screenshot state — see named 5% |
| Tenancy enforced structurally (§10.5) | verified | `TenantScopedManager` is the *only* default manager on `BaseModel`; `grep -rn "\.all_objects\." apps/ --include="*.py" \| grep -v tests/ \| grep -v models.py` → empty (the only non-test, non-definition use of the escape hatch is inside the diagnostic testapp, which is test infrastructure) | |
| No secrets committed | verified | `backend/.env` (real local values) confirmed gitignored: `git check-ignore -v backend/.env` → matched by `.gitignore:6:.env`; only `.env.example` (placeholder values) is tracked | Nothing has been `git commit`-ed yet this session at all — repo is `git init`-only per your instruction |
| Rate limiting active + demonstrated triggering | verified | `apps/identity/tests/test_throttling.py::test_repeated_login_attempts_are_throttled` — 11 rapid requests, 10× `200`, 11th `429` | Was **not implemented** until this self-check caught the gap against the brief's cross-cutting requirements; now wired via DRF `ScopedRateThrottle` (`throttle_scope = "auth"`, `10/min`), backed by Redis cache (not per-process `LocMemCache`, so it actually works across multiple workers) |
| Audit records for privileged/money-moving actions | not applicable at this phase | `AuditLog` model + `record_audit_event()` write-helper exist (`apps/core/models.py`, `apps/core/audit.py`) | No privileged action exists yet to call it — first real caller lands in Phase 1 (Client/Business approval) |
| Query counts on list endpoints (N+1) | not applicable at this phase | — | No list endpoint exists yet |
| Migrations additive/reversible | verified | All 5 migrations (`clients.0001`, `core.0001`/`0002`, `identity.0001`, `core_testapp.0001`) are `CreateModel`/`AddField`-only — inherently additive, nothing destructive | |
| Docker Compose full stack | verified | `docker compose up -d` → postgres (healthy), redis (healthy), backend (started, migrated), celery-worker (started, connected to Redis) | Rebuilt and re-verified after the Redis-cache settings change |
| CI workflow (`.github/workflows/ci.yml`) | unverified (reason: no CI runner or git remote in this session) | Workflow reviewed line-by-line for correctness (correct action versions, Postgres+Redis services, `btree_gist` bootstrap, per-project lint/test loops with the fix for the `npm run x -- --flag` forwarding bug, e2e job wiring) | Cannot execute a GitHub Actions run without pushing to a remote, which wasn't requested this session |

## Findings (ordered by severity — all three below were found and fixed in this session, not left open)

1. **[Fixed, was serious] `AuthLayout`'s `cdkTrapFocus` violated axe's `aria-hidden-focus` rule.** `projects/layout/src/lib/auth-layout.ts`. CDK's focus-trap boundary anchors are `tabindex="0"` + `aria-hidden="true"`, correct only inside a modal with background content to shield — wrong on a full standalone page. Fix: removed the focus trap; a login page has no background content to trap focus away from.
2. **[Fixed, was moderate] No `<main>` landmark on `/login` or `/home`.** `projects/layout/src/lib/auth-layout.ts`, `projects/layout/src/lib/forbidden-page.ts`, each app's `home.html`. Axe's `landmark-one-main`/`region` rules. Fixed by rooting each page's content in `<main>`.
3. **[Fixed, was a real correctness bug, not just style] Unreachable "wrong audience" error path in `apps/identity/serializers.py`.** The tenant/audience-scoped `_candidate_queryset` already filters by role, so the separate `_user_allowed()` check and its distinct error message could never fire — dead code discovered because an e2e test asserting that exact message failed. Removed the dead branch; the (correct, more secure) actual behavior is a generic "no active account" message for wrong-role login attempts too, which doesn't leak that an email exists under a different role. e2e test corrected to match.
4. **[Fixed, low severity, real bug] Test-isolation bug: the throttle test polluted shared Redis cache state for other tests.** Django rolls back DB transactions per test but not cache backend state. Fixed with an autouse `cache.clear()` fixture in `backend/conftest.py` rather than patching the one test, since any future cache-touching test would hit the same class of bug.
5. **[Fixed, real gap against the brief] Rate limiting on auth endpoints was entirely missing** despite being an explicit cross-cutting requirement. Added `ScopedRateThrottle` (`10/min`) on all three token-obtain views, backed by Redis (not in-process cache, which wouldn't work once there's more than one backend process).
6. **[Fixed, real gap] `/api/v1/auth/token/refresh/` had no test coverage**, and the claim that custom JWT claims (`aud`, `client_id`, `is_platform_staff`) survive a refresh had never actually been exercised — only asserted in a docstring. Added two tests; confirmed the claim is true.
7. **[Not fixed, deliberately deferred — flagged, not fixed] `/home` displays the raw `client` UUID.** This is Phase 0's intentional diagnostic view (proves the JWT → `/me` → UI round trip), not a real dashboard. A human-readable client name requires the Client model to grow past its Phase 0 minimal shape, which is explicitly Phase 1 scope (`docs/adr/0001`). Left as-is per §10.6.3's boundary (would require a data-model change, which is out of the "may fix without asking" bucket).

## 1a. Visual iteration log

One iteration, exited on criteria met (not the 5-iteration cap). Full detail in `docs/ui-review/phase-0-foundation/iteration-1.md`. Summary: captured `/login` (empty, validation-error) and `/home` (populated) for all three apps at their authoritative viewports (390px customer-app, 1440px client-admin/super-admin) — 12 screenshots, all actually opened and visually reviewed, not just markup-reasoned-about. Two real accessibility defects found (items 1–2 above) and fixed; screenshots promoted to `docs/ui-review/phase-0-foundation/baseline/`.

## 2. Deviations from the brief

- **A minimal `Client` model was created in Phase 0**, even though the brief's phase plan puts "Client" in Phase 1. Necessary because `BaseModel`'s tenancy FK needs a concrete table to reference — see `docs/adr/0001`'s note on this. No KYC/business features attached; Phase 1 extends the same table additively.
- **A test-only diagnostic model (`TenancyProbe`)** exists solely to prove the tenancy base classes work before a real business model does, installed only under `config.settings.ci`. Documented in `docs/adr/0002` and this file; should be deleted once a real model can take over that role (Phase 1+).
- **Login requires an optional `client` disambiguation field** instead of true subdomain-based Client resolution, since `WhiteLabelConfig`/domain mapping doesn't exist yet. Documented as a Phase 1 follow-up in `apps/identity/serializers.py`'s docstring and `docs/adr/0002`.
- **Frontend conventions were explicitly NOT checked against `securepay-mono-repo`** per your instruction — judged directly on UI/UX quality instead (§10.6 above), not on fidelity to an unseen reference repo.
- **Row-Level Security (Postgres, defense-in-depth alongside the ORM-level tenancy filter) was not implemented** — flagged as an open ADR decision (`docs/adr/0002`) to resolve before Phase 1's models carry real tenant data, per the plan.

## 3. The named 5%

- **RLS is not in place.** The ORM-level `TenantScopedManager` + middleware is the only enforcement layer. A raw SQL query or a mistaken `Model.all_objects` call in future code would bypass it; the adversarial test fixture (`apps/core/tests/tenancy.py`) catches this per-model but only for models tests are actually written against. Closing this requires the RLS ADR decision + migration, tracked in `docs/adr/0002`.
- **The CI workflow has never actually run.** It's been reviewed carefully (including catching and fixing the `npm run x -- --flag` argument-forwarding bug before it could bite in a real run), but there's no substitute for a first real execution on GitHub's runners — environment differences (Chrome flags, Docker-in-Docker behavior for the e2e job, secret availability) could still surface something this local review can't catch.
- **Keyboard-only completion and visible-focus-state verification is thorough for customer-app but not independently re-verified for client-admin-app/super-admin-app** — they share the identical `Login`/`TextField`/`Button` components, so a regression specific to one of those two apps is unlikely, but "unlikely" isn't "verified."
- **768px viewport wasn't captured as a distinct state** (see `docs/ui-review/phase-0-foundation/iteration-1.md`) — low risk given how simple these two screens are, but a real gap against the brief's three-viewport capture requirement.
- **The Redis-backed cache/throttle setup has only been exercised by a single test process against a single Redis instance on one machine.** It should work correctly under real multi-worker production load (that's the whole reason it's Redis-backed, not `LocMemCache`), but this hasn't been load-tested.
- **Dead code and unreachable branches are the class of bug this session's own review process just demonstrated it's not immune to** (finding #3) — this codebase is roughly 24 hours old; the same review rigor applied here (write a test, watch it fail, ask "wait, why did that fail," fix the real cause) needs to keep happening every phase, not just this one.

## 4. Honest confidence per module

- **Tenancy base classes (`apps/core`)**: high confidence. Adversarial tests exist, structurally the only path to data is the scoped manager, and I've now traced the "what if this is never a real model" question explicitly via the documented testapp pattern. Lowest-confidence sub-piece: the RLS gap above.
- **Identity/auth (`apps/identity`)**: high confidence, but this module is exactly where this self-check found the most real bugs (unreachable error branch, missing throttle, missing refresh test, cache-isolation bug) — all fixed, but that density of findings in one module, found only because I went looking hard, is itself informative: this is the highest-value area to scrutinize again before Phase 1 builds RBAC on top of it.
- **Angular workspace/shared libraries**: high confidence for what exists (Button, TextField, Alert, AuthLayout, ForbiddenPage, ListStore, AuthStore, PermissionsService, guard, directive) — all have real unit tests, not scaffolding. Lower confidence on long-term ergonomics of `ListStore` specifically, since nothing has used it yet (no real domain store exists to prove the abstraction is actually the right shape once Phase 3 needs it).
- **Docker Compose / infra**: high confidence — rebuilt and re-verified twice in this session, including after a settings change.
- **CI workflow**: medium confidence — carefully written and one real bug already caught by re-reading it, but zero actual executions.
- **Overall Phase 0**: I'd put this at meeting the brief's ~95% standard for what's actually built — the residual 5% above is named specifically, not hand-waved, and three of the seven findings in this report were bugs that would have shipped silently if I'd stopped at "the code looks right" instead of running things and reading the output.
