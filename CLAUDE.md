# CLAUDE.md

Guidance for Claude Code (or any contributor) working in this repo.

**This file is rules, not history.** It is loaded into context on every
session and after every compaction, so it stays short on purpose. The
narrative — what each phase shipped, and the reasoning behind every
lesson below — lives in [`docs/status.md`](docs/status.md). Read that
when you need the *why*; read this to know what to type.

| Need | Read |
|---|---|
| How to build a backend slice | [`docs/backend-patterns.md`](docs/backend-patterns.md) |
| How to build a frontend slice | [`docs/frontend-patterns.md`](docs/frontend-patterns.md) |
| What has been built, and why it is that way | [`docs/status.md`](docs/status.md) |
| What to build next | [`docs/specs/README-transit-os-adoption.md`](docs/specs/README-transit-os-adoption.md) |
| A feature's design + implementation record | `docs/specs/<n>-*.md` |
| Load-bearing architectural decisions | `docs/adr/0001`–`0008` (all Accepted) |
| Concrete traps, "never do this", known gaps | [`docs/traps.md`](docs/traps.md) |
| What "done" means | [`docs/self-check.md`](docs/self-check.md) |
| System reference, technical / non-technical | `docs/architecture.md` / `docs/executive-overview.md` |

## What this is

Integra AFC — an Automated Fare Collection platform for African
transport operators (Lagos commuter shuttle, intercity bus, Botswana
metro). One Django/DRF backend; four white-labeled Angular 20 frontends
(customer, client-admin, super-admin, validator) sharing libraries in
one Angular CLI workspace. `validator-app` is an installable PWA
standing in for the still-out-of-scope Flutter validator app.

**Status: phases 0–12 and specs 13–21 are all complete — the Transit OS
adoption roadmap is done.** 1185/1185 backend tests, 1645 frontend unit
tests, four Playwright projects. See `docs/status.md` and the roadmap.

**Next: nothing scheduled.** The roadmap
([`docs/specs/README-transit-os-adoption.md`](docs/specs/README-transit-os-adoption.md))
has no further spec. The self-check catch-up for specs 19–21
(`docs/self-check-2026-09-12-specs19-21.md`) and the fix batch it led
to are both done — every gap that report and `docs/traps.md` named
(`ui-map` contrast, `ui-table` Senior Mode density, `trip-search`'s
Route picker, `NavShell`'s icon rail, the KYB queue search, the
`prune_e2e_test_data` KYB-document cascade, and the real bug behind the
one Playwright interference case) is fixed — see `docs/traps.md`'s own
entries for each, dated 2026-09-12. What's actually owed now: three
**new**, unrelated defects this fix batch's own full-suite verification
surfaced (a `client-admin-app` route row's action menu that reports
`aria-expanded` but never renders its items; a pre-existing
`aria-allowed-role` axe violation in `live-operations`'s trip-picker
list; and data drift on this dev database's shared "Yaba → Lekki" trip
fixture — duplicate rows, one incorrectly `in_progress`) — all named in
`docs/traps.md`'s "Known gaps" section, none fixed. Don't start any of
this without being
asked.

## How we work

1. **Spec before code.** Every phase/module gets a spec at
   `docs/specs/<n>-<module>.md` (scope, data model, API surface, edge
   cases, failure modes, test plan, migration impact) before
   implementation starts.
2. **ADRs for architectural decisions**, including options rejected and
   why — `docs/adr/`.
3. **Thinnest vertical slice first**, then stop for review. Backend +
   frontend for one feature beats a complete backend with no consumer.
4. **Never guess on ambiguity.** Label unavoidable assumptions
   `ASSUMPTION:` in output.
5. **Self-check before declaring anything done** — `docs/self-check.md`
   defines what "done" means and says to run one at the end of every
   module and every phase; reports land at `docs/self-check-<date>.md`.
   Two halves, both of which were being skipped:
   - **A spec is not closed until its report exists.** The last one is
     `docs/self-check-2026-09-07-specs12-18.md`, a catch-up pass over
     specs 12–18 (automated checks + prior-findings audit only — no
     fresh Playwright/visual-loop run; see its named 5%).
   - **Every report re-verifies the previous one's open findings**
     against current code and says of each: closed, still open, or
     deliberately carried. Unchecked, they rot in both directions — one
     was fixed four specs ago while this file still called it a
     known-red, and three others have sat untouched since August.
6. **When a slice is done, write its Implementation note in its own
   spec.** Everything else — the roadmap row, `docs/architecture.md`,
   `docs/status.md` — gets a short pointer, not a retelling.
7. **Name the next unit of work when a slice closes.** The closing
   report ends with what is next and which spec owns it, and the
   **Next** line above is updated to say the same — a session opening
   after a compaction should not re-derive it from the roadmap. Nothing
   is started off that line without being asked.

### Working without burning context

Measured on spec 17 slice 1: three `Explore` subagents cost **304,627
tokens** to re-derive conventions that had not changed in months, and
this file cost ~20,700 tokens on every session start *and* every
compaction. Both are now fixed; keep them fixed — including by keeping
this file itself small, which is why concrete traps live in
[`docs/traps.md`](docs/traps.md) rather than here (see that file's own
note on where a new one goes).

- **A spec is a plan.** For "build slice N of spec M", read the spec and
  build. Plan mode is for genuinely novel or ambiguous work, not for
  restating a spec that already has a data model, API surface, edge
  cases and test plan.
- **Read `docs/backend-patterns.md` / `docs/frontend-patterns.md`, not
  three apps.** If either is wrong, fix it there. A standard slice
  should need no exploration agent at all.
- **Prefer targeted reads.** `grep`, `sed -n 'A,Bp'`, and reading the
  one reference implementation beat a broad sweep. Pipe long command
  output through `tail`; never read `openapi.yaml` or `schema.ts`.
- **If you do spawn an agent, pass `model: sonnet`.** Locating code does
  not need frontier reasoning, and the same sweep costs roughly a fifth.
- **Write the account once.** The spec's Implementation note is the
  record; everything else gets a pointer.
- **This file stays under ~4k tokens.** A conceptual rule (how we work)
  goes here. A concrete trap — a class, a file, a symptom, a fix — goes
  in `docs/traps.md`. Either way, the full reasoning goes in
  `docs/status.md`; if a change doesn't change what you type, it belongs
  in neither.

## Repository layout

```text
backend/    Django project — apps/ per bounded domain (see docs/adr/0001)
frontend/   Angular CLI workspace — projects/ (4 apps + shared libraries)
docs/       specs, ADRs, self-checks, UI review screenshots
.github/    CI workflow
```

### Backend apps (`backend/apps/`)

`core` (tenancy base classes, RLS, `IdempotencyKey`, `AuditLog`,
health), `identity` (custom User, JWT audiences, Role/Permission),
`clients` (tenant root, KYC, white-label), `businesses` (KYB),
`network` (Route/Stop/RouteStop), `fleet` (VehicleType/Vehicle/Driver),
`scheduling` (Schedule/Trip), `fares` (versioned FareRule +
segment rules), `seating` (Seat/SeatReservation), `booking`, `tapngo`
(pay-as-you-go fare determination), `ledger` (double-entry, ADR-0006),
`payments` (Paystack, ADR-0007), `wallet`, `ticketing` (signed QR,
ADR-0005), `notifications`, `analytics`, `incidents`, `telemetry`
(vehicle position ingest + live state), `activity` (passenger history
feed).

`wallet`, `analytics` and `activity` have **no models of their own** —
they are read layers. A domain app earns its place by owning a
boundary, not a table. Per-app detail is in `docs/status.md`.

### Frontend (`frontend/projects/`)

`customer-app` (:4200), `client-admin-app` (:4201), `super-admin-app`
(:4202), `validator-app` (:4203, PWA) — each with its own
`src/environments/` wired via `angular.json` `fileReplacements`.
Libraries: `shared-ui` (presentational components), `shared-data`
(`ListStore`), `auth` (`AuthStore`, `authMiddleware`, `permissionGuard`,
`*appHasPermission`), `layout` (`NavShell`, `NotificationBell`),
`api-client` (generated `schema.ts` + openapi-fetch wrapper).

## Commands

### Backend (`cd backend`)

```bash
uv sync
uv run python manage.py migrate
uv run python manage.py runserver
uv run pytest --cov=apps --cov-report=term-missing
uv run ruff check . && uv run mypy .
uv run python manage.py spectacular --file openapi.yaml --validate
./scripts/check_openapi_drift.sh
uv run python manage.py seed_e2e_users              # test fixtures, NOT demo data
uv run python manage.py prune_e2e_test_data [--dry-run]   # dev/CI only
```

Settings modules: `config.settings.{local,ci,staging,production}` via
`DJANGO_SETTINGS_MODULE`; `local` is `manage.py`'s default.

### Frontend (`cd frontend`)

```bash
npm install
npm run start:customer | start:client-admin | start:super-admin | start:validator
npm run build:all
npm run test:all
npx ng lint <project>          # no combined target; loop per project
npm run openapi:generate && npm run openapi:check
npx playwright test --project=<name>
```

### Full stack

```bash
docker compose up          # postgres (+ btree_gist), redis, backend, celery worker/beat
docker compose exec backend python manage.py migrate
```

## Conventions

**Backend**: fat services / thin views. `Decimal` for money with an
adjacent currency field, UTC datetimes, type hints throughout (`mypy` in
CI), `ruff` for lint + format. Tenant-owned models inherit
`core.models.BaseModel` and are queried only through `objects` unless
cross-client access is deliberate and explicit (`all_objects`).

**Frontend**: Angular CLI workspace (not Nx). Standalone components (no
`standalone: true` — implicit in v20), `input()`/`output()` functions,
`ChangeDetectionStrategy.OnPush` everywhere, native control flow
(`@if`/`@for`), `host` object not `@HostBinding`/`@HostListener`,
reactive forms only, `inject()` over constructor injection, Tailwind v4
first (CDK `Dialog` for overlays, CDK `BreakpointObserver` for
breakpoints). No `.component` suffix. Path aliases across library
boundaries only (`@shared-ui`, `@shared-data`, `@auth`, `@layout`,
`@api-client`) — never deep relative imports into another project.
