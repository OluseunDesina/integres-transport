# Self-check — Phase 1 (Identity, Client, Business) — 2026-08-08

Scope: all 5 Phase 1 slices (`docs/specs/1-identity-client-business.md`)
— the RLS mechanism, Client self-registration + KYC, Business + KYB,
Role/Permission/StaffInvitation, and WhiteLabelConfig + subdomain
resolution + client-invitation flow. Each slice was individually verified
(tests/lint/build/manual smoke) at the end of its own slice, but per
CLAUDE.md's working agreement no **phase-level** self-check had been run
until now — only Phase 0 has one (`docs/self-check-2026-08-07.md`). This
report closes that gap. Booking/payment/wallet/ledger/ticket items in
§10.2–§10.3 remain **not applicable at this phase** (Phase 3+), unchanged
from Phase 0's own report.

## 10.7 Report table

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Angular v20 convention greps (§10.1) | verified | All 11 greps (`standalone: true`, `@HostBinding`/`@HostListener`, `*ngIf`/`*ngFor`/`*ngSwitch`, `ngClass`/`ngStyle`, `@Input()`/`@Output()`, `.mutate(`, `*.component.ts`, deep relative imports, `: any`/`<any>`/`as any`, `@ngrx`, hardcoded URLs) returned zero matches across `frontend/projects/`, except generated `@example` doc-comment URLs inside `schema.ts` (excluded, same as Phase 0) | |
| `OnPush` on every component | verified | Scripted check over every `@Component`-decorated, non-spec file — zero missing | |
| Reactive forms only, no `ngModel` | verified | `grep -rn "ngModel" projects/ --include="*.html"` → empty | |
| Backend `ruff check .` / `mypy .` | verified | Both `All checks passed!` / `Success: no issues found in 85 source files` (scoped to `apps config`, excluding a container-local `.venv` artifact that isn't present when run via `uv run` — pre-existing repo quirk, not a Phase 1 change) | |
| Money = `Decimal` + currency field | not applicable at this phase | `grep -rn "DecimalField\|FloatField" apps/*/models.py` → empty | `Business.currency` is a plain field per the spec's own non-goal — no money movement yet |
| All stored datetimes UTC | verified | `TIME_ZONE = "UTC"`, `USE_TZ = True`, unchanged since Phase 0 | |
| Backend `pytest` suite | verified | `124 passed`, 98% coverage (`--cov=apps`) — up from 23 at the end of Phase 0 | |
| Cross-client isolation, per-model RLS adversarial tests | verified | Dedicated raw-SQL test file per RLS-protected model: `test_kyc_rls.py` (KycDocument), `test_business_rls.py` (Business), `test_identity_rls.py` (Role, StaffInvitation), `test_white_label_rls.py` (WhiteLabelConfig — new this phase) | |
| Registry-driven RLS-completeness test | verified | `test_row_level_security.py::test_every_concrete_base_model_subclass_has_rls_enabled` — picked up `WhiteLabelConfig` automatically, zero test changes needed | Confirms the registry-driven design works as intended across a phase boundary |
| Every endpoint has a test | verified | All 27 named URLs across `core`/`clients`/`businesses`/`identity` (`urls.py`+`staff_urls.py`) have at least one `reverse()` call in the test suite — scripted diff, zero missing | `admin/`, `schema/`, `docs/` are framework-provided, excluded per Phase 0's precedent |
| OpenAPI spec regenerates with no diff | verified | `check_openapi_drift.sh` → `OpenAPI schema matches committed openapi.yaml.` (backend + frontend `openapi:check`), re-confirmed after the N+1 fixes below (no contract change) | 2 pre-existing `drf-spectacular` enum-naming-collision warnings (`status` fields across multiple models) — cosmetic, schema still valid, not fixed (naming, not a defect) |
| Migrations additive/reversible | verified | Every migration across all 5 slices is `CreateModel`/`AddField`/`AddConstraint`/`RunPython` (with a matching reverse function) or `EnableRowLevelSecurity` — no `RemoveField`/`DeleteModel`/`RemoveConstraint`/`AlterField` anywhere | Slice 5's `0004_whitelabel_clientinvitation.py` round-tripped (apply → unapply → reapply) cleanly |
| Playwright e2e (§10.3) | verified | 16/16 pass in isolation (per-project and per-file); full-suite run flagged below (throttle finding) | Traces captured (`--trace=on`) |
| Flow 1 — registration→business→KYC/KYB→approve→signs in | verified (API-only, no UI this phase) | Each step tested: `test_registration.py` (register), `test_business.py` (add business), `test_kyc_queue.py::test_full_register_reject_resubmit_reapprove_flow` + `test_kyb_queue.py::test_full_create_reject_resubmit_reapprove_flow` (submit→reject→resubmit→approve) | No single test exercises all steps as one chain — each step's service is shared and independently tested, per the spec's own "exercised via API" plan (no super-admin UI until Phase 2) |
| Flow 2 — super-admin invites a client → completes onboarding | verified | `test_client_invitations.py::test_complete_produces_identical_state_to_direct_registration` — full create→resolve→complete chain in one test, asserting identical Client/User/Role state to direct registration | |
| Accessibility — axe on every reachable Phase 1 screen (§10.4) | verified | `/register` (the only new screen): axe-checked at empty, validation-error, server-error-banner, and success states — 2 of these were previously uncovered, found and fixed this session (see Findings) | `/login`/`/home` unchanged from Phase 0's own coverage |
| Keyboard-only completion | verified | Added for `/register` this session (previously absent) — full form completable via Tab + Enter, lands on `/home` | |
| Tenancy enforced structurally, `all_objects` usage audited (§10.5) | verified | `grep -rn "\.all_objects\." apps/ --include="*.py" \| grep -v tests/` → 9 hits, all manually justified: 2 super-admin-queue serializer document lookups, 2 KYB queue/decide views, 1 KYB decide service call, 3 `platform_staff_bypass()`-wrapped identity/service calls, 1 white-label domain resolver — no stray/undocumented usage | |
| No secrets committed | verified, with caveat | `backend/.env` correctly matched by `.gitignore:6:.env`; `git status --porcelain` shows no `.env`-pattern files | **Caveat, stated plainly**: this repo has zero commits at all (`git status` → "No commits yet") — this check confirms `.gitignore` correctness for *when* something is committed, not that nothing has leaked, since nothing has been committed yet at all |
| Rate limiting active + demonstrated triggering | verified — and self-triggered unintentionally | `apps/identity/tests/test_throttling.py` (unchanged, still passing); **also independently re-confirmed live** against the real Docker stack when this session's own testing activity (repeated curl calls + repeated full Playwright runs) tripped the `auth` scope's 10/min budget, producing a real "Request was throttled" banner in a live browser | See Findings — this exposed a real test-infrastructure margin issue, not a product defect |
| Audit records for privileged/money-moving actions | verified | Every `record_audit_event()` call site added this phase (`client.invited`, `client.invitation_completed`, `white_label.updated`, plus Slices 2–4's existing ones) matches §4's **[audited]** column; append-only guarantee (`AuditLog.save()`/`delete()` raising `ValueError`) previously had **no dedicated test** — added this session (`apps/core/tests/test_audit.py`, 3 tests) | Real test-coverage gap found and fixed |
| Query counts on list endpoints (N+1) | **failed → fixed** | `django_assert_max_num_queries` probes found 3 real N+1s: `ClientKycQueueSerializer.get_documents` (1 query/row), `BusinessKybQueueSerializer.get_documents` + its `client_name` field (2 queries/row), `StaffSerializer`'s nested `role`/`role.permissions` (2 queries/row). All three fixed (batched lookups + `select_related`/`prefetch_related`) and locked in with permanent regression tests (`test_queue_query_count_does_not_scale_with_client_count` etc.) | See Findings — this is the highest-value thing this self-check found |

## Findings, ordered by severity

1. **[Fixed, was a real performance bug] Three N+1 query patterns on list/queue endpoints.** `apps/clients/serializers.py::ClientKycQueueSerializer.get_documents`, `apps/businesses/serializers.py::BusinessKybQueueSerializer.get_documents` (plus its `client_name` field), `apps/identity/views.py::StaffListView`/`RoleListView`. Each fired one or two extra queries per row instead of one query per page — confirmed via `django_assert_max_num_queries` probes before fixing (12 queries for 5 KYC-queue rows; would scale linearly, meaning it gets worse as more Clients register). Fixed via a batched-lookup pattern (using the fact DRF's `many=True` reuses one child-serializer instance across all rows, cached on `self`) for the two queue serializers, and `select_related`/`prefetch_related` for the two staff/role list views. All four fixes locked in with permanent regression tests asserting a flat query-count ceiling, not proportional to row count.
2. **[Fixed, real test-coverage gap] `AuditLog`'s append-only guarantee had no dedicated test.** The `save()`/`delete()` guard (`ValueError` on update/delete) has existed since Phase 0 and is relied on by every privileged action added since, but nothing exercised it directly. Added `apps/core/tests/test_audit.py` (3 tests: update rejected, delete rejected, `record_audit_event`'s target-based `client_id` resolution).
3. **[Fixed, real accessibility gap] `/register`'s validation-error and server-error-banner states were never axe-checked, and no keyboard-only completion test existed for it at all.** `frontend/e2e/client-admin-app/register.spec.ts` only axe-checked the empty and success states (2 of 4 reachable states) and had zero keyboard-navigation coverage, despite `/login` establishing that pattern in Phase 0. Fixed: added `AxeBuilder` assertions to the two previously-uncovered states, and a new keyboard-only completion test mirroring `e2e/customer-app/login.spec.ts`'s existing pattern. All 6 tests in the file pass in isolation.
4. **[Not fixed — flagged for explicit decision, touches an auth-security parameter] The shared `auth` DRF throttle scope (10/min, applied to every `AllowAny` token/register/invite-accept/invite-complete endpoint with no per-purpose separation) is tight enough that the full Playwright suite self-throttles when run within one 60-second window.** Root-caused precisely, not guessed: the suite's total real POST requests to `auth`-scoped endpoints was already exactly 10 (the limit) before this phase's own additions; finding #3's new keyboard-only registration test added an 11th, tipping it over. Confirmed via: (a) the exact "Request was throttled. Expected available in 52 seconds." banner captured live in a failing test's screenshot, (b) a `throttle_auth_172.18.0.1` key found in Redis matching the scope and source IP, (c) both `super-admin-app`'s suite and `register.spec.ts` passing 100% in isolation, proving the code is correct and this is purely shared-budget exhaustion. **Not fixed**, because every available fix touches an auth-security parameter (raising the throttle rate, even CI/local-only) or CI runtime behavior (serializing e2e execution) — exactly the category this self-check's own boundary rule says to report and leave for explicit review rather than silently change. Left as-is; Redis was flushed to leave the repo in a clean, unthrottled state.
5. **[Not fixed — deliberately deferred, unchanged from Phase 0] `/home` still displays the raw `client` UUID**, now shown again post-registration and post-invitation-completion in this phase's new flows. Same reasoning as Phase 0's report: this is the intentional diagnostic view, not a real dashboard; fixing it is a Phase 2+ UI concern.
6. **[Observation, not a defect] `drf-spectacular` emits 2 enum-naming-collision warnings** (multiple `status`-named `TextChoices` across different models resolving to ambiguous generated enum names, e.g. `StatusE94Enum`). The schema is still valid and drift-check passes; this is purely a generated-name aesthetic issue, fixable later via `ENUM_NAME_OVERRIDES` if it ever causes real confusion in the generated TypeScript client. Not touched this pass.

## 1a. Visual iteration log

One iteration, exited on criteria met (not the 5-iteration cap). Full
detail in `docs/ui-review/1-identity-client-business/iteration-1.md`.
Summary: captured `/register` (client-admin-app's one new Phase 1 screen)
at empty/validation-error/server-error/success states, 390/768/1440px
(1440 authoritative) — 12 screenshots, all opened and visually reviewed.
Zero visual defects found (no clipping, overflow, misalignment; consistent
with the Phase 0 design-language baseline). One accessibility gap found
during the same pass and fixed (Finding #3, not a visual/CSS defect so
tracked separately from the loop's own defect table). Screenshots
promoted to `docs/ui-review/1-identity-client-business/baseline/`.

## 2. Deviations from the brief

- **`WhiteLabelConfig`/`ClientInvitation` live in `apps.clients`**, not a
  new app — a scope decision made and documented in the Slice 5 plan, not
  a spec deviation (the spec doesn't mandate an app boundary for these).
- **`ClientInvitation` is registered in Django admin**; `WhiteLabelConfig`
  is not — asymmetric but deliberate: `ClientInvitation` isn't RLS-
  protected (no Client exists at invite time, same reasoning as
  `Permission`), so the cookie-auth-resolves-as-anonymous admin gap
  (flagged repeatedly since Phase 0) doesn't apply to it.
- **No `StaffInvitation`/`ClientInvitation` revoke endpoint** — the data
  model supports the state (`status=revoked`), tested by constructing it
  directly; no endpoint built, per each slice's own explicit non-goal.
- **`GET /white-label/resolve/` trusts `request.get_host()`** — correct
  for this phase's scope (proving the resolution logic + graceful
  localhost fallback), but production reverse-proxy/DNS topology for
  white-labeled custom domains is explicitly out of scope, `ASSUMPTION:`,
  same "documented but unbuilt" treatment AWS provisioning got in Phase 0.
- **The repo has zero git commits** — everything from Phase 0 through this
  report has been built as uncommitted working-tree state. Not a code
  deviation, but worth surfacing here since it affects what "no secrets
  committed" (above) actually proves.

## 3. The named 5%

- **The shared `auth` throttle scope's tight margin (Finding #4) is a real,
  live fragility, not fully closed.** It will keep getting tighter as
  future phases add more e2e coverage against `AllowAny` endpoints unless
  addressed — either by splitting throttle scopes per purpose (DRF's
  `ScopedRateThrottle` supports multiple named scopes) or accepting
  occasional full-suite self-throttling as a known characteristic. Left
  for explicit decision.
- **Flow 1's five steps (registration→business→KYC/KYB→approve→sign-in)
  are each independently tested but never exercised as one continuous
  chain in a single test** — unlike Flow 2, which does get one true
  end-to-end test. The underlying services are shared and each step's
  contract is verified, so the risk is low, but a genuine integration
  bug spanning two steps (e.g., a Business created before Client KYC
  approval somehow blocking KYB review) wouldn't necessarily be caught
  by today's suite. Named explicitly rather than assumed away.
- **The CI workflow has still never actually run** — same gap Phase 0's
  report named, still true; environment differences on GitHub's runners
  remain unverified by this local-only review.
- **Production reverse-proxy/DNS topology for white-labeled domains is
  entirely unbuilt and unverified** — `GET /white-label/resolve/`'s
  correctness depends on the browser's real Host header reaching the
  backend unchanged, which this phase deliberately didn't attempt to
  simulate or prove beyond the documented `ASSUMPTION:`.
- **The two `drf-spectacular` enum-naming warnings** are cosmetic today
  but unverified against what they'd actually generate in the TypeScript
  client if a future model added a third colliding `status`-named choice
  set — not stress-tested at 3+ collisions.
- **Dead code / unreachable branches remain a class of bug this process
  isn't structurally immune to** (same observation Phase 0's report made
  about itself) — this self-check found real bugs by measuring things
  (query counts, actual throttle behavior against a live stack) rather
  than only reading code, which is exactly the discipline that needs to
  keep happening every phase.

## 4. Honest confidence per module

- **RLS mechanism + tenancy (`apps.core`, cross-cutting)**: high
  confidence. Every RLS-protected model added across all 5 slices has its
  own adversarial raw-SQL test, the registry-driven completeness test
  picked up `WhiteLabelConfig` with zero changes (proving the design
  holds across a phase boundary, not just within one), and the
  `all_objects` audit found zero undocumented escape hatches.
- **Client/Business/KYC/KYB (`apps.clients`, `apps.businesses`)**: high
  confidence, but this is exactly where the N+1s were found — both queue
  serializers had the identical bug shape, meaning it's a pattern to
  watch for deliberately in future list/queue endpoints, not a one-off.
  Fixed and regression-tested, but this module's query-efficiency
  discipline was genuinely weaker than its correctness discipline before
  this pass.
- **Identity/RBAC (`apps.identity`)**: high confidence — same finding
  pattern (N+1 in `StaffListView`/`RoleListView`) caught and fixed here
  too. Permission enforcement itself (the actual security logic) has no
  findings against it this phase.
- **Frontend (`register` screen + `WhiteLabelResolverService`)**: high
  confidence for the screen itself (zero visual defects across 12
  screenshots at 3 viewports); the accessibility-coverage gap (Finding
  #3) was a testing gap, not a rendering defect — the screen was already
  accessible, it just wasn't being checked as thoroughly as `/login`.
- **Test infrastructure (Playwright + the shared auth throttle)**: medium
  confidence. The suite is correct and every spec passes in isolation,
  but Finding #4 shows the full-suite run is now living at a margin that
  will keep tightening — this is the lowest-confidence area in this
  report, specifically because the fix requires a decision this
  self-check deliberately didn't make unilaterally.
- **Overall Phase 1**: meets the brief's ~95% standard for what's
  actually built. The residual 5% is named specifically above, and two of
  this report's six findings (the N+1s, the audit-log test gap) were real
  bugs/gaps that would have shipped silently if this self-check had
  stopped at "the existing per-slice tests all pass" instead of measuring
  query counts and re-running the accessibility suite against every
  reachable state.
