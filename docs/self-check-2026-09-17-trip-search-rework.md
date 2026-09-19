# Self-check — trip search rework (source/destination flow)

Not a numbered spec — an ad-hoc, user-approved rework of `customer-app`'s
trip search (Route-first → origin/destination text search with price and
stop count on results, matching Wakanow's flow at the user's request).
Scoped to that module only: `apps.network.services.find_route_stop_matches`,
`GET /stops/suggest/`, the reshaped `GET /trips/search/`, and
`trip-search.ts`/`.html`. The rest of the platform is untouched and out of
scope for this report.

## 0. Previous report's open findings, re-verified

Last report: `docs/self-check-2026-09-12-specs19-21.md`, whose three
carried findings live in `docs/traps.md`'s "Known gaps" section. All three
are in `client-admin-app`/dev-data, none touched by this module:

- **`routes.spec.ts` action-menu dropdown not rendering** — still open.
  Not re-verified in depth (no `ActionMenu`/`route-list.ts` file touched
  this session); carried as-is.
- **`live-operations.spec.ts` `aria-allowed-role` axe violation** — still
  open, same reasoning: no file in that path touched.
- **Shared "Yaba → Lekki" fixture trip data drift (duplicate rows, one
  wrongly `in_progress`)** — **closed, incidentally.** Earlier in this
  session (unrelated task) every Business except "GUO Transport" was
  deleted and `seed_e2e_users` was re-run to rebuild fixtures for this
  module's own e2e verification. That wiped the corrupted rows and
  recreated a single clean "Yaba → Lekki" Business/Route/Trip set from
  scratch — confirmed via `docker compose exec backend python manage.py
  shell` query showing exactly one `Yaba → Lekki` Route, `active` status,
  clean Trip rows for today. No code fix was involved; the underlying
  `ActionMenu`/`live-operations` defects were not touched and are not
  claimed fixed.

## 1. Findings

**F1 — Medium — `apps/scheduling/views.py` `TripSearchView.get()`, query
cost scales with match/result count, one avoidable N+1.**

Reproduced with a throwaway `CaptureQueriesContext` test (3 matching
routes × 1 trip each, then 4 more priced trips — 7 result rows total):
**28 queries** for one request. Breakdown, by table, in order: 3 fixed
(auth + the two `RouteStop` queries `find_route_stop_matches` runs once
regardless of match count — that part is correctly O(1)), then per
matched route **one `Trip` query**, then per resulting row **one
`Business` query + one `FareRule` query**.

- The `Business` query is avoidable and free to fix: `TripSearchView.get()`
  does `Trip.objects.select_related("route", "vehicle", "driver")` but
  not `"business"`, and `apps.fares.services.get_fare()` reads
  `trip.business` internally — one extra query per result row for
  nothing. Fix: add `"business"` to that `select_related(...)`.
- The `FareRule`-per-row query is inherent to `get_fare()`'s per-trip
  resolution and is **new cost this feature specifically asked for**
  (showing a price on every result) — no fare lookup existed on this
  endpoint before. Not a regression; a real, deliberate tradeoff.
- The per-matched-route `Trip` query could be batched into one
  `route_id__in=[...]` query grouped in Python, cutting that count to 1
  regardless of how many routes a search matches — a further, slightly
  larger optimization, not done here.

At today's realistic scale (a Client runs a handful of routes; a search
typically matches 1–3) this is not urgent, but it is a genuine, verified
inefficiency in code from this session, not a hypothetical one — listed
per §10.5 rather than fixed silently. Not yet fixed; ask before I do,
since it touches the same file as the endpoint's other tests.

**F2 — Low/cosmetic — the From/To suggestion dropdown overlays the field
below it while open, hiding that field's label.**

Confirmed on real screenshots at both the authoritative 390px width and
1440px (`private/tmp/.../scratchpad/shots-390/2-from-suggestions.png` and
`shots-1440/2-from-suggestions.png`, this session): with the From
dropdown open, the "Travel date" label directly beneath it is fully
covered. This is standard combobox/overlay behaviour (the same pattern a
native `<select>` or Wakanow's own airport picker uses — it does not push
sibling content down, by design), and the layout is confirmed to resolve
correctly the instant a suggestion is picked or the field blurs
(`4-results.png` shows a completely clean form). Recorded because
§10.6.2 asks for exactly this class of observation, not because it
blocks anything — a small polish (e.g. a touch more `gap-y` before the
next field, or a subtle drop shadow to make the overlay read as clearly
floating) would make the overlap read as more obviously intentional, but
this is optional.

**F3 — Informational, not a finding — `[ngModel]`/`ngModelOptions` on the
Class filter's `ui-select`.**

`grep -rn "ngModelOptions" projects/*/src --include=*.html` returns 27
files; this is the codebase's existing, deliberate pattern for driving a
`ControlValueAccessor`-based shared component outside a `FormGroup`
(`ui-select`, `ui-text-field`), not the "no reactive forms" violation the
self-check's convention grep is aimed at (a raw native input bypassing
Angular forms). The original `trip-search.ts` used the identical pattern
before this rework. No action needed.

## 2. Deviations from the brief

None against the user-approved plan. One deliberate product decision
made during implementation, named at the time: the Class filter now
always offers all four classes before a search runs (previously it
narrowed to the one selected Route's `available_trip_classes`) — there is
no longer a single "selected Route" to narrow against before a search,
since one origin/destination pair can match several Routes with
different allow-lists. Narrowing still happens on *results*.
`trip-classes.spec.ts`'s pre-existing test asserting the old narrowed-list
behaviour was updated to assert this instead.

## 3. Convention compliance

```
$ grep -rn "standalone: true\|@HostBinding\|@HostListener" trip-search.ts
$ grep -rn "\*ngIf\|\*ngFor\|\*ngSwitch\|ngClass\|ngStyle" trip-search.html
$ grep -rn "@Input()\|@Output()\|\.mutate(\|: any\b\|<any>\|as any" trip-search.ts trip-search.html
$ grep -rn "http://\|https://" trip-search.ts
```
All four return nothing. `ChangeDetectionStrategy.OnPush` set explicitly
(`trip-search.ts`, `@Component` decorator). No `.component` suffix. No
deep relative imports across library boundaries (this module doesn't
cross one). `[ngModel]` present only on the Class `ui-select` — see F3.

Backend: `ruff check` and `mypy` both clean on every changed file
(`apps/network/services.py`, `apps/network/views.py`,
`apps/network/serializers.py`, `apps/scheduling/views.py`,
`apps/scheduling/serializers.py`, `apps/core/management/commands/
seed_e2e_users.py`) — pasted output, this session. Money: `fare.amount`
is `Decimal` end to end (`TripFareQuoteSerializer`, reused unchanged from
`apps.fares`), with `currency` as an adjacent field; no float touches it.
No new datetime field added; existing ones untouched.

## 4. Backend verification

- Full suite: `uv run pytest -q --create-db` → **1212 passed**, this
  session.
- New tests exist and pass, by name: `apps/network/tests/
  test_route_stop_matching.py` (12 tests: direction, cross-route
  exclusion, inactive-stop exclusion, non-active-route-status exclusion,
  multi-match-per-term, case-insensitivity, cross-Business-same-Client,
  **cross-Client isolation**, stop-count arithmetic);
  `apps/network/tests/test_stop_suggest.py` (11 tests, including
  **cross-Client isolation** and passenger-vs-staff 403); `apps/
  scheduling/tests/test_trip_search.py` (21 tests, rewritten, including
  cross-client isolation, `FareNotConfigured` exclusion, status/PAYG
  filtering).
- OpenAPI: `./scripts/check_openapi_drift.sh` → "OpenAPI schema matches
  committed openapi.yaml", 9 pre-existing unrelated warnings (confirmed
  via `git diff openapi.yaml` before this session's changes — enum-name
  collisions elsewhere in the schema).
- Coverage on changed files (`--cov=apps.network --cov=apps.scheduling`):
  `network/services.py` 94% (5 lines missing are `update_stop`, unrelated
  to this module), `network/views.py` 99% (1 line missing, pre-existing
  `StopListCreateView` branch), `scheduling/views.py` 97%, `scheduling/
  serializers.py` 91% (missing lines are other, untouched serializers in
  the same file). `find_route_stop_matches`, `StopSuggestView`,
  `TripSearchView`'s new code paths: **100%**, own test files.
- Endpoints touched: both new/changed ones (`/stops/suggest/`,
  `/trips/search/`) have dedicated test files, listed above. No endpoint
  in this module ships untested.

## 5. Playwright end-to-end verification

Run against the real stack (`docker compose`, seeded via `seed_e2e_users`
after a fix — see Findings-adjacent note below):

- `booking.spec.ts` (6 tests), `open-seating.spec.ts` (1 test),
  `trip-classes.spec.ts` (4 tests) — **11/11 passed**, real backend, real
  Postgres, this session.
- Full `customer-app` project (43 tests): **41 passed, 1 failed, 1
  skipped**. The one failure, `activity-feed.spec.ts`'s "is reachable
  from the home screen", is a pre-existing strict-mode locator collision
  (the page's own "Activity" `<h1>` and an unrelated "No activity yet"
  `<h2>` both match a substring `getByRole('heading', { name: 'Activity'
  })`) — no file this module touched is involved; not fixed, not in
  scope.
- **A real bug was found and fixed to get here**: `seed_e2e_users`'s
  fixture Routes came back in `draft` status after this session's earlier
  DB wipe (routes.status.default is `draft`; nothing in that command ever
  activated them), which made `find_route_stop_matches`' (correct,
  intentional) `status=ACTIVE` filter — the same filter `RouteBrowseView`
  already enforced — find nothing. Fixed by calling `set_route_status(...
  , ACTIVE)` after each fixture Route's fare is seeded, worked around the
  documented `platform_staff_bypass()` vs. `TenantScopedManager` contextvar
  trap the same way `_seed_boardable_open_seating_ticket` already does in
  that file. Re-seeding is now idempotent (verified: ran twice, second
  run clean).
- New e2e assertions added per the plan's own ask: a zero-stop match
  renders "Direct" (`open-seating.spec.ts`), a multi-stop match renders
  its count, and both a `Direct` and a `1 stop` case are asserted from
  one shared fixture route in a new `booking.spec.ts` test — all passing
  against real seeded data, not mocked.

## 6. Accessibility

- `booking.spec.ts`/`trip-classes.spec.ts`'s existing `AxeBuilder` checks
  (results list, review screen, dialog) all still assert zero violations
  and pass.
- New surface never axe-checked before this report: the suggestion
  **combobox itself, open**, with real `role="combobox"`/`"listbox"`/
  `"option"`, `aria-expanded`, `aria-selected`. Ran a real `AxeBuilder`
  pass against the live From-field dropdown open with real data —
  **zero violations** (this session, throwaway spec, output captured:
  `AXE VIOLATIONS (dropdown open): []`).
- Keyboard: `Enter` selects a focused suggestion (`(keydown.enter)` on
  each option), `Escape` closes either dropdown. Not run through a full
  keyboard-only pass of the whole search-to-seat-picker flow this
  session — carried into the named 5% below.

## 7. Security and correctness sweep

- Tenancy: both new endpoints read exclusively through `.objects`
  (`RouteStop.objects`, `Stop.objects`, `Trip.objects`), the
  contextvar-and-RLS-scoped manager — never `.all_objects`. Cross-client
  isolation is asserted by name in both new test files (see §4) and
  passes.
- N+1: see F1 — checked and reported, not silently ignored.
- No migration in this module (no model field added).
- No secret or hardcoded URL in any changed file (§3's grep).
- Rate limiting / audit logging: unchanged by this module (no new
  privileged or money-moving action introduced — search is read-only).

## 8. Visual iteration

One capture round, not the full 5-iteration §10.6 loop (this is a single
feature's form + result list, not a multi-screen module) — screenshots
taken and **actually viewed**, at 390px (authoritative) and 1440px, for:
empty form, From-dropdown-open, To-dropdown-open, populated results,
empty-results. All fine except F2 above (overlay, not a defect). No
console-error check was run this round — named below as unverified.

## 9. The named 5%

- **F1 not fixed** — a real, verified inefficiency left as a finding
  pending your go-ahead, not a silent gap.
- **768px was not captured** — only the authoritative 390px and a desktop
  1440px check ran; a mid-width regression between them would not be
  caught by this report.
- **Browser console errors/warnings were not checked** during the visual
  pass (§10.6.4 asks for zero) — screenshots were reviewed, the console
  was not.
- **No full keyboard-only run** of search → suggestion pick → search →
  seat picker (only Enter/Escape on the combobox itself were exercised
  directly; `booking.spec.ts`'s own keyboard test still uses `.fill()` for
  the From/To text, not Tab+arrow-key navigation through suggestions).
- **The two carried client-admin-app findings** (action-menu, aria-role)
  were not re-investigated — confirmed out of scope, not re-verified in
  depth.

## Summary

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Convention compliance (frontend) | verified | §3 greps, all empty | — |
| Convention compliance (backend) | verified | `ruff`/`mypy` clean, this session | — |
| Backend tests | verified | 1212 passed, `--create-db` | — |
| Backend coverage (changed files) | verified | 91–100% on touched files | gaps are pre-existing, unrelated lines |
| OpenAPI drift | verified | "matches committed openapi.yaml" | 9 pre-existing warnings |
| Cross-client isolation (new endpoints) | verified | named tests in §4, passing | — |
| N+1 / query cost | **finding (F1)** | 7 rows → 28 queries, captured | not yet fixed, needs go-ahead |
| Frontend unit tests | verified | 1642 passed, all 4 apps | from prior verification pass, unchanged since |
| E2e (module-relevant) | verified | 11/11, real stack | required a real seed-data bug fix first |
| E2e (full customer-app) | verified | 41/43 | 1 pre-existing unrelated failure |
| Accessibility (combobox) | verified | 0 axe violations, dropdown open | full keyboard-only flow not run |
| Accessibility (results/review) | verified | existing axe checks still pass | — |
| Visual review | verified | 390px + 1440px, viewed | 768px not captured; F2 noted, not blocking |
| Security sweep | verified | tenancy managers + isolation tests | no migration, no new privileged action |

**Honest confidence: high (~90%) on correctness and isolation, medium-high
on performance at real scale (F1 named, not fixed), medium on visual
completeness (one width pair, one pass, no console/keyboard-only check).**
The lowest-confidence area is F1 — it is verified real but its actual
impact at production data volumes was not measured against real traffic
shape, only synthesized.
