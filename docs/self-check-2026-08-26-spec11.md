# Self-check — 2026-08-26 — spec 11 (KYB Directors)

Scope: `docs/specs/11-kyb-directors.md`, backend and frontend, plus the
cross-cutting defects this pass surfaced.

**Why this document exists at all.** Spec 11 was reported complete on
test-suite results alone. Asked whether the self-check had been run, an
audit against `docs/self-check.md` showed it had not: §10.1's convention
greps were never executed, §10.3's Playwright run covered only
`client-admin-app` while `super-admin-app` had been modified and never
tested, §10.6's visual iteration loop was skipped entirely, and no §10.7
report existed. This pass closes those gaps.

The §10.6 omission was the costly one. It found two High-severity
defects within minutes, one of them a screen that could not open half
the businesses in the database.

## Status

| Area | Status | Evidence | Notes |
|---|---|---|---|
| §10.1 Angular conventions | **verified** | All greps run; zero hits from this slice | Pre-existing only: 4 `@HostListener` in `projects/layout/`, generated `schema.ts` example URLs |
| §10.1 `ruff` | **verified** | `All checks passed!` | |
| §10.1 `mypy` | **verified** | `no issues found in 269 source files` | |
| §10.2 Backend suite | **verified** | `609 passed, 1 failed` (`--create-db`) | +2 this pass. The failure is `test_ticket_completion_concurrency.py`, an untracked file predating this work |
| §10.2 Cross-client isolation | **verified** | `test_directors.py::test_cross_client_{create,patch}_is_a_404_not_a_403`, `test_list_only_returns_the_callers_own_directors` | Per endpoint, not per model |
| §10.2 RLS registry | **verified** | `apps/core/tests/test_row_level_security.py` passes with `Director` registered | No allowlist |
| §10.2 N+1 | **verified** | `test_queue_query_count_does_not_scale_with_director_count` | Batched, ≤15 queries for 5×3 directors |
| §10.2 OpenAPI drift | **verified** | `OpenAPI schema matches committed openapi.yaml` / `api-client schema.ts matches` | |
| §10.3 Playwright — super-admin | **verified** | **16/16** | Was 6 passed / 2 failed / 7 not run at the start of this pass |
| §10.3 Playwright — customer-app | **verified** | **10/10** | Was 1 failed / 4 not run — never run in this session until the final pass |
| §10.3 Playwright — validator-app | **verified** | **5/5** | |
| §10.3 Playwright — client-admin | **failed** | **68/69** | One failure, F6 below — a real product defect, left red rather than skipped |
| §10.4 Accessibility | **verified** | axe clean on the KYB screen, the KYB queue, and the open decide dialog | |
| §10.5 Migrations additive/reversible | **verified** | `0008` is `CreateModel` + `AddField`; `EnableRowLevelSecurity.reversible = True` | |
| §10.5 Tenancy | **verified** | `Director` uses `BaseModel`/`.objects`; queue reads via `all_objects` under `IsPlatformStaff` | |
| §10.5 Rate limiting | **unverified** | Not exercised | Unchanged by this slice; no auth/seat-hold/booking endpoint added |
| §10.6 Visual loop | **verified** | `docs/ui-review/11-kyb-directors/` — 2 iterations, 27 images each, `baseline/` promoted | **Exited on criteria, not the cap** |
| §10.7 Report | **verified** | This document | |
| Frontend unit tests | **verified** | shared-ui 55, shared-data 5, auth 26, layout 39, api-client 2, client-admin **295**, super-admin 67, validator 31 | client-admin +5 |
| Frontend builds | **verified** | 4/4, **zero compiler warnings** | Five NG8107/NG8113/NG8102 warnings cleared |
| customer-app unit tests | **failed** | `1 FAILED, 119 SUCCESS` | `AppShell links to all passenger destinations` — pre-existing; customer-app untouched this pass |

## Findings, by severity

### F1 (High, fixed) — a screen could not open half the businesses

`business-kyb.ts` and `business-form.ts` resolved a business from one
bounded 25-row page and fell through to "That business couldn't be
found." Against 77 businesses, index 25 onward was unreachable,
including `GIGL` — real data with 3 directors and 4 documents.

Third instance of a family CLAUDE.md already records twice
(`SelectedBusinessStore`, `BusinessSuperAdminStore.findById()`).
`business-form.ts`'s docstring had recorded it as an accepted
limitation; it was not.

Fixed with `BusinessStore.findById()` and four store tests, one
reproducing the exact broken case.

**Found only by §10.6.** Prior live verification used a freshly created
business, which always sorts onto page 1.

### F2 (High, fixed) — the add-director form gave no validation feedback

`ui-text-field`/`ui-select` render errors only when the parent binds
`[invalid]`/`[errorMessage]`. This template bound neither, so an empty
submit did nothing visible. Directly contrary to the standing request
for "frontend and backend form validations, with apt response to the
user."

The covering test asserted only that `POST` was not called — never the
rendered output — so it passed throughout. Now asserts the message and
`aria-invalid`.

### F3 (Medium) — the same bounded-page family, six more times

`driver-form`, `vehicle-type-form`, `schedule-form`, `stop-form`,
`vehicle-form` and `route-form` all resolved edit-mode records from one
25-row page. Reported here as open and outside spec 11.

**Closed 2026-08-27**, and it was seven screens, not six — `seat-map`
had the same defect in a worse form (a `computed()` over the shared
root store's `items()`, so another screen paginating `VehicleTypeStore`
made this one's record silently `null` mid-session). Fixed once in
`ListStore.findByIdPaged`; the two hand-written predecessors now
delegate to it. See `docs/architecture.md`'s "Client-admin UX hardening
— Slice 2" row.

### F4 (Medium, fixed) — review queues ranked by creation, not submission

`KybQueueListView` and `KycQueueListView` inherited `-created_at`, so a
business registered months ago but submitted this morning sorted below
everything created after it. Creation time and submission time are
different facts and only the second is what a queue is about.

Now `order_by("kyb_submitted_at")` / `("kyc_submitted_at")` — oldest
submission first, FIFO. Two tests that create rows in one order and
submit them in the reverse one, so the two facts are distinguishable.

### F5 (Medium, fixed) — the bookings trip filter ignored the selected business

`booking-list.ts` fetched trip options unscoped, its comment stating
that `GET /trips/` had no `business` param. True when written; the param
exists now and `trip-list` already uses it. Now scoped, with a test.

### F6 (Medium, open) — the trip filter cannot reach recent trips

`booking-list.ts` requests `limit=100, offset=0`, and
`Trip.Meta.ordering` is **ascending** by `service_date`. A business with
more than 100 trips therefore offers its *oldest* hundred, and no recent
trip is selectable.

Measured: one business, `Integra E2E Network Test Business`, has **387**
trips; its dropdown covers `2026-08-10 → 2026-08-26` only.

**This is the one failing client-admin e2e test**
(`bookings.spec.ts:148`). I previously reported that failure as "pure
dev-DB cruft." That was wrong: 387 trips for a single business is a
realistic volume, and the filter breaks for any business past 100 trips
regardless of how the rows got there. Business scoping (F5) shrinks the
problem without removing it.

Closing it needs a searchable trip picker or a date-bounded query —
new API surface, so reported rather than fixed, and the test is left
**failing rather than skipped**.

### F6b (Medium, fixed) — three more e2e specs were silently broken

Running the projects I had never run turned up three failures that had
nothing to do with spec 11, and everything to do with the same
bounded-fetch family:

- **`customer-app/booking.spec.ts` selected the fixture route by exact
  label.** `trip-search.ts` appends an em-dash plus the operator name to every option as
  soon as the browse endpoint spans more than one Business, which the
  tap-and-go fixture alone guarantees. Broken since that fixture
  landed; unnoticed because this project's e2e suite had not been run
  since. Now matched on a label prefix and selected by value.
- **Both booking specs looked the fixture vehicle up in one `?limit=50`
  page.** With 104 vehicles, `E2E-1234-LA` had fallen off it, failing
  as `Cannot read properties of undefined (reading 'id')` several
  frames later. Extracted `findVehicleByRegistration` into
  `frontend/e2e/fixture-lookup.ts`, which pages and throws a message
  naming the missing fixture.

customer-app e2e went from 1 failed / 4 not-run to **10/10**;
validator-app is **5/5**.

### F6c (Low, open) — the four e2e projects interfere when run together

`npx playwright test` with no `--project` gave 3 failures that vanish
when each project runs alone. `super-admin`'s `kyc-queue` spec approves
the shared KYC fixture, and `client-admin`'s `kyc-status` spec expects
it `submitted`; the booking specs contend for the same fixture seats.
Each project is green in isolation. Not fixed — the fix is either
per-project fixtures or a global serial ordering, both larger than this
pass.

### F7 (Medium, open) — the KYB queue has no search

36 near-identical rows, 25 per page, no filter or search. A reviewer
cannot find a named business. New functionality.

### F8 (Low, open) — `prune_e2e_test_data` cannot clear review queues

Confirmed empirically: 28 businesses deleted, **46 skipped (protected)**,
and the KYB queue stayed at 36. `KybDocument.business` is
`on_delete=PROTECT`, and a queue row has a document by definition — so
the pruner can never remove one. CLAUDE.md hints at this; it is now
measured.

Consequently the KYB queue grows monotonically with every e2e run.
`kyb-queue.spec.ts` now pages to its fixture instead of assuming page 1,
which is also what a real reviewer does.

**A near-miss worth recording**: the prune's dry run listed `GIGL` and
`GIGM` — hand-built, non-fixture businesses — for deletion, because they
live under the same hardcoded e2e Client. Both survived as protected,
but the command's "only touches the e2e Client" guarantee does not
distinguish fixtures from real work done while signed in as that
account.

### F9 (Low, open) — `NavShell` keeps an icon rail at 390px

~45px, 12% of the viewport, on every client-admin screen. Pre-existing
and shared; 1440 is this app's authoritative viewport.

### F10 (Low, open) — approved businesses show all-pending documents

`kyb_status` is decided per business; `KybDocument.status` is never
advanced, so an approved packet renders every document as `pending`.
Backend semantics, which §10.6.3 bars fixing inside the visual loop.

## Deviations from the brief

1. **Spec 11 was declared done without §10.6, §10.7, or a Playwright run
   against a modified app.** The direct cause of F1 and F2 reaching this
   audit.
2. **F5's fix is outside spec 11.** It completes a request already made
   ("filter entities like trips by the already selected business") whose
   backend half I built and whose frontend half I left undone.
3. **F4 extends to the KYC queue**, which spec 11 does not mention. The
   defect is identical and the two queues are the same screen for two
   models; leaving them disagreeing would have been the worse call.
4. **`E2E_SKIP_SEED=1`** was added to `global-setup.ts` so Playwright can
   run against a `uv`-hosted backend. Skipping the seed silently caused
   5 spurious KYC failures in this pass before I noticed — the fixture
   is force-reset to `submitted` on every seed run, and without that
   reset a prior run's approval leaves the queue empty.

## The named 5%

- **`Director` under real concurrency is untested.** No spike test; two
  simultaneous adds of the same person produce two rows. There is no
  uniqueness constraint on `(business, full_name)` and arguably should
  not be — but nothing proves the intended behaviour either way.
- **Uploads are only tested with tiny synthetic PDFs.** No size cap, no
  MIME sniffing, no malformed-file path. A 200MB upload or a `.pdf` that
  is really an executable is unexercised.
- **`MEDIA_ROOT` is local disk.** Production storage remains documented
  but unbuilt, so nothing here says whether these documents survive a
  real deployment.
- **The visual loop judged one browser** (Chromium, macOS). Font-metric
  differences elsewhere could reopen the wrapping defects at 390px.
- **The backend Docker image still predates Phase 6's
  `cbor2`/`pynacl`.** Everything here ran against a `uv`-hosted backend,
  so nothing in this report proves the containerised stack works.
- **Directors are captured but never verified.** No OCR, no identity
  provider, no cross-check that an uploaded ID matches the name typed
  beside it — deliberate per the spec's non-goals, but it means "KYB
  passed" currently means "a human looked at a filename."

## Confidence

| Module | Confidence | Where it is lowest |
|---|---|---|
| `businesses.Director` (backend) | **High** | Concurrency and uniqueness semantics |
| KYB document → director linking | **High** | Serializer shape now asserted at the response level, after a live round-trip returned a name where the schema promised a UUID |
| `business-kyb` screen | **High** | Was Medium before §10.6; two High defects found and fixed |
| KYB/KYC queue ordering | **High** | Newly tested both ways |
| `booking-list` trip filter | **Low** | F6 is open and its e2e test is red |
| The bounded-page lookups (F3) | **High** *(was Low)* | Closed 2026-08-27 — one implementation, tested in `shared-data` and per store, and all seven deep links verified cold in a real browser |

Lowest confidence overall is now **F6** alone, and it is the one open
finding whose e2e test is deliberately left red. F3 was the other, and
is closed.
