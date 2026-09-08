# 16-Operational-Analytics: Dashboard, revenue, transactions, performance, export

Fourth spec of the Transit OS adoption arc, and the largest. Depends on
spec 15 (revenue breaks down by trip class).

## Scope and non-goals

`transit-admin-app-prompt.md` asks for a dashboard, a revenue reporting
area ("one of the most important features"), a transactions screen with
a metrics strip, per-trip performance analytics, and CSV export from
filtered views. None of it exists: `client-admin-app`'s `home` is a
static list of permission-gated links, and no endpoint in this backend
returns an aggregate of any kind.

The brief's instruction to build these against mock data is dropped, so
the substance of this spec is **backend aggregation**, not charts.

### Why this cannot be done client-side

Every metric here could in principle be derived by fetching lists and
reducing them in the browser. It must not be. `CLAUDE.md` records four
separate production bugs from the "bounded fetch, then reduce/`.find()`
locally" pattern — `SelectedBusinessStore`, two `super-admin-app`
config screens, and `booking-list`'s trip dropdown, which is *still*
red for exactly this reason. A dashboard doing it would be that bug
class at its worst: silently wrong totals, plausible enough that nobody
checks.

### In scope

- Aggregation endpoints for the dashboard, revenue, payment summary and
  per-trip performance.
- Server-side CSV export honouring the caller's active filters.
- Two enabling model changes (payment channel, actual trip times).
- `ui-chart`, the one shared primitive this spec owns. The rest of the
  console UI kit (filter bar, page header, action menu, drawer, toasts,
  top-bar quick actions, sticky headers, density) comes from spec 14,
  which is sequenced before this one.
- Four `client-admin-app` screens: dashboard (replacing `home`),
  revenue, transactions, trip performance.

### Non-goals

- **No pre-aggregated tables, no materialised views, no warehouse.**
  Aggregates are computed at query time against the operational tables.
  This is right at current volumes and wrong eventually; the boundary
  is named under Failure modes rather than pre-solved.
- **No scheduled or emailed reports.** Export is a synchronous download
  the operator asks for.
- **No cross-Client analytics.** Everything is scoped to the caller's
  Client, and further filterable by Business. Platform-wide reporting
  belongs to `super-admin-app` and is not this spec.
- **No forecasting, anomaly detection, or "insights".** The brief's
  "peak demand insights" is served by an existing-data trend chart, not
  a model.
- No change to the ledger's chart of accounts (ADR-0006).

## Data model changes

Two additive fields. Both exist because a metric the brief requires is
currently underivable, not because analytics wants a convenience column.

### `payments.PaymentIntent.channel`

`CharField(max_length=32, blank=True, default="")`.

The brief requires a payment-method breakdown (card / bank transfer /
USSD / wallet). Paystack **returns** the channel on a successful
charge; `apps/payments/psp/paystack.py` discards it. Without capturing
it there is nothing to break down by.

Populated in the existing `charge.success` webhook branch from the
event payload's `data.channel`. Blank for historical rows and for
intents that never succeeded — the breakdown reports those as
`unknown` rather than guessing.

A wallet-funded booking is already distinguishable without this field
(`wallet_component_amount > 0`), and a fully wallet-paid booking has no
`PaymentIntent` PSP leg at all. The breakdown therefore reports
**wallet as its own channel**, sourced from the ledger rather than from
Paystack. Stated explicitly because a naive `GROUP BY channel` would
under-report wallet spend to zero.

### `scheduling.Trip.actual_departure_at` / `actual_arrival_at`

Both `DateTimeField(null=True, blank=True)`.

The brief requires on-time status and delay duration. `Trip` currently
records `scheduled_departure_at` and `status_changed_at` — the latter
is a single mutable field overwritten by every transition, so it cannot
tell you when a Trip *departed* once it has since completed. Delay is
not derivable today.

Written by `apps.scheduling.services` on the existing status
transitions: `→ in_progress` stamps `actual_departure_at`,
`→ completed` stamps `actual_arrival_at`. Both nullable forever: a
Trip cancelled before departure has neither, and historical Trips have
neither. Every metric derived from them reports "unknown" rather than
zero when they are null.

No scheduled *arrival* time exists anywhere in the model, so **delay is
measured at departure only**. Arrival punctuality would need a
scheduled-arrival field on `Schedule`/`Route`; named as a gap, not
built.

### New permission codename

`analytics.view`, seeded in an `apps/identity` data migration alongside
the existing codenames and granted to the Owner and Manager presets in
`DEFAULT_ROLE_PERMISSIONS`. **Not** granted to Staff: revenue totals
are a different sensitivity from the operational lists Staff needs.

Export reuses the permission of the resource being exported
(`payments.view` for transactions, `analytics.view` for revenue) rather
than inventing an `export.perform` — a caller who can read a list can
read it as a file.

## API surface

All under `analytics.view` unless noted. All accept a common filter
set; all are `GET`-only and read-only.

| Method | Path | Permission | Returns |
|---|---|---|---|
| `GET` | `/analytics/dashboard/` | `analytics.view` | The whole dashboard envelope in one request |
| `GET` | `/analytics/revenue/` | `analytics.view` | Totals, trend series, and breakdowns |
| `GET` | `/analytics/payments/summary/` | `payments.view` | The metrics strip above the transactions table |
| `GET` | `/analytics/trips/{id}/performance/` | `analytics.view` | One trip's operational and financial outcome |
| `GET` | `/exports/{resource}/` | resource's own | Streaming CSV |

`GET /payments/` (the transactions table itself) already exists and
gains filter parameters only.

### Common filter parameters

`business`, `route`, `trip_class`, `date_from`, `date_to`, `status`,
`channel`. Every one optional; every one applied identically by the
list endpoint, the summary endpoint and the export, so **the numbers
above a table always describe the rows in it**. This is enforced by a
single shared filter class, not by three hand-written `.filter()`
chains.

### One request, not fifteen

`GET /analytics/dashboard/` returns a single envelope:

```jsonc
{
  "currency_scoped": true,
  "period": { "from": "2026-08-01", "to": "2026-08-30", "timezone": "Africa/Lagos" },
  "routes":   { "active": 12, "inactive": 3, "archived": 1 },
  "trips":    { "scheduled": 40, "in_progress": 6, "completed_today": 22, "cancelled": 1 },
  "bookings": { "total": 1840, "paid": 1699, "cancelled": 88 },
  "incidents":{ "open": 4 },                       // 0 until spec 17 lands
  "money": [                                        // one entry per currency — see below
    { "currency": "NGN", "revenue": "1840500.00",
      "average_ticket_value": "1082.11", "transaction_volume": 1701 }
  ],
  "trends": {
    "revenue":  [ { "date": "2026-08-01", "currency": "NGN", "amount": "61000.00" } ],
    "bookings": [ { "date": "2026-08-01", "count": 61 } ]
  },
  "recent_incidents":    [ /* ≤5 */ ],
  "recent_transactions": [ /* ≤5 */ ]
}
```

The envelope shape follows the precedent set by
`GET /trips/{id}/availability/` in spec 10: a bare array made "no
vehicle assigned" and "every seat taken" indistinguishable, and the
fix was to say which state you are in rather than let the client infer
it from emptiness. The same rule applies here — a dashboard must
distinguish "no revenue" from "no data for this period".

### Money is grouped by currency, never summed across it

`Business.currency` is per-Business and a Client can run several
Businesses. Summing a Naira total and a Pula total into one number
produces a figure that is not money. Every monetary aggregate in every
endpoint is therefore **an array keyed by currency**, and the UI renders
one card per currency rather than one card.

This is the single easiest way to get this feature quietly, seriously
wrong, so it is a shape constraint in the API rather than a note in the
UI.

### Revenue is read from the ledger, and must not join `LedgerAccount`

Revenue comes from `apps.ledger` journal lines, not from summing
`PaymentIntent.amount` — the ledger is the system of record and already
accounts for the commission split.

`docs/specs/5-payments-wallet-ledger.md`'s Slice 1 note records a real
bug here: a `select_related` against the RLS-protected `LedgerAccount`
table silently dropped journal lines referencing the platform
commission account when read by an ordinary Business's staff. The fix
was to read the FK id directly rather than joining. **Every aggregation
query in this spec follows that rule** — filter and group on
`account_id` values resolved separately, never on a joined
`account__account_type`.

### Trip performance

```jsonc
{
  "trip": { "id": "…", "route": "Ikeja → CMS", "trip_class": "premium",
            "status": "completed", "booking_mode": "reservation" },
  "capacity": { "total_seats": 44, "seats_sold": 39, "occupancy_rate": "0.886" },
  "punctuality": { "scheduled_departure_at": "…", "actual_departure_at": "…",
                   "delay_minutes": 12, "on_time": false },
  "money": { "currency": "NGN", "revenue": "42120.00", "revenue_per_seat": "957.27" },
  "incidents": 1,
  "cancelled": false
}
```

`occupancy_rate` is `null`, not `0`, when the Trip has no vehicle
assigned (no denominator) — and for open-seating trips the denominator
is the Business capacity, not a seat count, since there are no `Seat`
rows. `punctuality` is `null` when `actual_departure_at` is.

### Export

`GET /exports/{resource}/` where `resource` ∈ `transactions`,
`revenue`, `route-revenue`, `trip-performance`, `bookings`, `incidents`.

- Streams via `StreamingHttpResponse` with a server-side iterator — the
  point of doing this on the server is that a browser export of a
  paginated list exports one page.
- Takes the identical filter parameters, so "export current view"
  really is the current view.
- `Content-Disposition: attachment` with a filename carrying the
  resource and the filter period.
- **Hard row cap** (`EXPORT_MAX_ROWS`, default 50 000). Over the cap the
  response is a `400` naming the cap and asking for a narrower range,
  not a truncated file that looks complete.
- CSV only. The brief lists "Excel-ready tabular export" and "JSON
  optional" — Excel opens this CSV, and JSON is deferred rather than
  built speculatively.

## Frontend design

### Built on spec 14's design system

`docs/specs/14-design-system-and-ui-rebuild.md` is sequenced **before**
this spec and owns the console UI kit: the token layer, `ui-filter-bar`,
`ui-page-header`, `ui-action-menu`, `ui-drawer`, `ui-skeleton`,
`ui-export-button`, toasts, top-bar quick actions, sticky table headers
and the density control.

These screens **consume** those; they do not define them. If this spec
is somehow built first, each is built here to spec 14's stated contract
and moves without change.

The one primitive this spec still owns, because it is its only consumer:

- **`ui-chart`** (`@shared-ui`) — the only place `chart.js` /
  `ng2-charts` is referenced, so the dependency stays swappable, the
  way `qrcode` and CDK are already contained. Wraps line, bar and
  doughnut. Every chart **must** be accompanied by an accessible
  equivalent: a visually-hidden data table or a `summary` input
  rendered for screen readers. A canvas is opaque to assistive tech,
  and "colour is not the only status indicator" is already this repo's
  a11y bar. Chart colours come from spec 14's tokens, so a
  white-labelled tenant's charts match their brand.

One rule this spec relies on and restates, because it is an
accessibility trap rather than a styling choice: **a toast must never
be the only place an error appears.** It disappears, and a screen
reader user may miss it, so every toasted failure also renders inline
in a `ui-alert`.

### Screens

`dashboard` (replaces `home` at `/home`), `revenue`, `transactions`,
`trips/:id/performance`. Stores are named as the brief names them —
`AdminDashboardStore`, `RevenueReportsStore`, `TransactionsStore`,
`TripPerformanceStore`, `ExportStore` — and extend `ListStore` wherever
they are paginated, rather than forming a parallel facade layer beside
it. The non-paginated ones (dashboard, revenue, performance) are plain
signal stores; `ListStore` is for collections and forcing them into it
would be abstraction theatre the brief itself warns against.

Any detail lookup by id uses `ListStore.findByIdPaged` with an
explicitly-passed scope — never `this.query()`, which inherits a
leftover filter and is itself a recorded bug.

## Edge cases

| Case | Expected behaviour |
|---|---|
| No data in the selected period | Endpoints return zeros with `period` echoed; screens render an empty state, not a spinner or a blank chart |
| Client with Businesses in two currencies | One money entry per currency; UI renders one card set per currency. Never summed |
| Business timezone vs UTC | Day buckets and "today" use `Business.timezone`. A Client spanning timezones and filtering across Businesses falls back to UTC, **and says so in the response** (`period.timezone: "UTC"`) |
| `date_from` after `date_to` | `400` |
| Range longer than a cap (e.g. 2 years) for a daily trend | `400` asking for a coarser granularity, rather than returning 730 points |
| Trip with no vehicle | `occupancy_rate: null`, not `0` |
| Open-seating trip | Denominator is Business capacity, not `Seat` count |
| Trip never departed | `punctuality: null` |
| Cancelled trip | Included in counts, excluded from occupancy and punctuality averages |
| Historical `PaymentIntent` with no `channel` | Reported as `unknown`, never guessed |
| Fully wallet-paid booking | Counted under the `wallet` channel from the ledger, not missing |
| Refunded / reversed | `PaymentIntent.requires_manual_refund` is surfaced as its own status facet; there is no refund service, so nothing is netted off automatically |
| Export over the row cap | `400` naming the cap. Never a silently truncated file |
| Export with zero rows | A valid CSV with headers only |
| Staff role (no `analytics.view`) | Nav entries hidden by `*appHasPermission`; direct navigation hits `permissionGuard` → `/forbidden` |

## Failure modes

- **Aggregation cost grows with the operational tables.** Query-time
  aggregation over `payments`, `booking` and `ledger` is correct and
  cheap now and will not stay cheap. The trigger to revisit is stated
  here: when the dashboard's p95 exceeds ~2s, or when a range query
  scans more than a few hundred thousand journal lines, the answer is a
  nightly rollup table — not an index band-aid. Indexes on the actual
  filter columns (`business`, `service_date`, `created_at`, `status`,
  `channel`) are added with this spec regardless.
- **Export vs. the platform request timeout.** Recorded hosting
  constraints include a 30-second function timeout. A streaming
  response that takes longer than that is killed mid-file and the
  operator gets a partial CSV that looks whole. The row cap is the
  primary mitigation; if it proves insufficient the follow-up is an
  async export (job + notification via the existing `apps.notifications`
  bell), which is deliberately **not** built here.
- **RLS on aggregate queries.** Aggregates run under the caller's
  ordinary tenancy context — no `platform_staff_bypass()` anywhere in
  this spec. That is the point: an aggregate that bypassed RLS would be
  the worst possible place to leak another Client's numbers. The
  `LedgerAccount` join prohibition above is the specific trap.
- **A metric and its table disagreeing.** Prevented structurally by the
  shared filter class rather than by discipline. If the summary and the
  list ever diverge, it is a bug in one place, not three.
- **Charts implying precision that isn't there.** Trend buckets with no
  data render as gaps, not as zero — a zero-revenue day and a day
  before the Business existed must not look identical.

## Test plan

### Backend

- Each endpoint's envelope shape, including the `period` echo and the
  currency-keyed money array.
- **Multi-currency**: a Client with an NGN and a BWP Business gets two
  money entries and no summed total. A direct regression test for the
  most damaging plausible bug in this spec.
- Timezone bucketing: a payment at 23:30 Lagos time lands in that
  Lagos day, not the next UTC one. Mixed-timezone Clients fall back to
  UTC and say so.
- Filter parity: for a given filter set, the summary totals equal the
  aggregate of the rows `GET /payments/` returns for the same filters,
  and equal the row count in the export. Asserted as one test across
  all three surfaces — this is what makes the numbers trustworthy.
- Revenue reconciles against `apps.ledger`: the reported total equals
  the sum of the Business clearing account's journal lines for the
  period, computed independently in the test.
- **The `LedgerAccount` join trap**: an aggregate read by ordinary
  Business staff over entries that include platform-commission lines
  returns the same total as the same read under
  `platform_staff_bypass()`. This is the spec-5 bug, re-asserted here
  where it would recur.
- Trip performance: occupancy `null` without a vehicle; open-seating
  denominator; punctuality `null` before departure; delay computed from
  `actual_departure_at`.
- Channel breakdown: wallet-funded bookings appear under `wallet`;
  channel-less historical intents appear under `unknown`.
- Export: streams, honours filters, caps with a `400`, emits headers on
  an empty result.
- **Cross-client isolation** (mandatory set): another Client's payments,
  bookings and ledger entries appear in none of these aggregates. Run
  against every endpoint, not just one.
- Permissions: `analytics.view` required; Staff preset denied; the
  codename is seeded by migration.

### Frontend

- `ui-chart`: renders each chart type; **renders its accessible
  equivalent** — asserted on the DOM, not on the canvas.
- Filter wiring on each screen: the filter set reaches the store, and
  round-trips through the URL so a filtered view is linkable. The
  `ui-filter-bar` component itself is spec 14's and is tested there —
  what is tested here is that these screens drive it correctly.
- Export failures render inline as well as in a toast (asserted, since
  "toast only" is the accessibility regression this could introduce).
- Each screen: loading, empty, error and populated states. Empty and
  error must be distinguishable — that distinction is the whole reason
  the envelope carries `period`.
- Stores: no raw state mutation from components; `findByIdPaged` used
  with an explicit scope on the performance screen.
- Per `docs/specs/10-booking-modes.md`'s recorded trap, any value
  derived from a plain form control uses `toSignal(control.valueChanges)`,
  not a bare `computed()` — and is asserted on **rendered** output,
  because Karma passes against that bug and a real browser does not.

### E2E

`client-admin-app`, per-project: sign in, land on the dashboard, assert
the metric cards and at least one chart's accessible table render;
filter the transactions screen by date and status and assert the
metrics strip changes with the table; trigger an export and assert the
download's `Content-Disposition` and header row. Axe pass on every new
screen.

## Migration impact

Additive only.

1. `PaymentIntent.channel` — nullable-equivalent (`blank`, `default=""`),
   no backfill possible or attempted. Historical rows report `unknown`.
2. `Trip.actual_departure_at` / `actual_arrival_at` — nullable, no
   backfill. `status_changed_at` cannot be reinterpreted as a departure
   time for past trips without lying, so it is not.
3. Indexes on the filter columns listed above.
4. `analytics.view` seeded in an `apps/identity` data migration,
   following the established `0003_seed_permissions.py` shape.

**Nothing destructive.** No approval required.

## Suggested implementation slicing

Four slices, stop for review between.

**Slice 1 — enabling fields.** `PaymentIntent.channel` captured in the
webhook; `Trip` actual times stamped on transition; indexes;
`analytics.view` seeded. No new endpoint. Small, and it starts
accumulating the data every later slice reports on — which is why it
goes first rather than being bundled.

**Slice 2 — aggregation endpoints.** The shared filter class, all four
analytics endpoints, and the reconciliation/isolation test suites. No
UI.

**Slice 3 — `ui-chart` and the dashboard.** The chart primitive and its
accessible equivalent, then the dashboard screen as its first consumer,
composed from spec 14's page header, filter bar and stat cards.

**Slice 4 — revenue, transactions, performance, and export.** The
remaining three screens plus the export endpoint and its buttons.

---

## Implementation note (Slice 1, done)

Built 2026-09-03. **811/811 backend tests** (up from 799), 1238 frontend
unit tests unchanged, four clean builds, lint clean on all nine
projects, OpenAPI drift clean both directions, all four e2e projects
green. Migrations applied to the real dev database and both write paths
exercised over real HTTP.

Backend only, no new endpoint, nothing rendered — so no §10.6 visual
loop.

### Why this slice is worth shipping on its own

Neither new field can be backfilled, and that is the entire argument
for the slicing. Paystack's channel exists only in the body of the
webhook that reports the charge; there is no API to ask for it
afterwards. And `Trip.status_changed_at` cannot be reinterpreted as a
departure time, which the live verification demonstrated rather than
argued:

```text
in_progress | departed: …:33.435193Z | arrived: None
completed   | departed: …:33.435193Z | arrived: …:33.496127Z

status_changed_at   …:33.496127Z     <- now the arrival time
actual_departure_at …:33.435193Z     <- survives only because it has
                                        a column of its own
```

Every day this is not deployed is a day of analytics data that does
not exist later.

### Two decisions taken with the user

**All three columns are exposed on the existing read serializers** —
`channel` on `PaymentIntentSerializer`, `actual_departure_at`/
`actual_arrival_at` on `TripSerializer`, all read-only. Three lines, no
new endpoint, and it makes the slice verifiable over real HTTP instead
of only in `psql`. `TripSerializer` already exposed `status_changed_at`,
so the pair sits beside the field whose inadequacy created them.

**Indexes land here rather than in slice 2**, as composites matched to
this spec's documented filter set. Postgres already indexes every FK,
so only the multi-column shapes are new: `PaymentIntent(business,
created_at | status | channel)`, `Trip(business, service_date |
status)`, `Booking(business, created_at | status)`, and
`JournalLine(account, created_at)`.

That last one is keyed on `account`, never on a joined
`account__account_type`, per this spec's own restatement of spec 5's
recorded bug. Slice 2 re-checks all eight against real query plans.

### Where each field is written, and why there

**The channel** is captured in `_handle_charge_success`, after the
`select_for_update()` and the `status != PENDING` guard, with its own
`save(update_fields=["channel"])` — **not** inside
`_apply_booking_payment` / `_apply_wallet_topup`. Those two are the
paths that differ, and both already end with their own narrow
`update_fields` list that a third payment shape would have to extend
again. One write in the shared caller instead.

Sitting *after* the status guard is load-bearing rather than
incidental: a replayed delivery returns at that guard, so what the
first delivery captured is what stands. There is a test for exactly
that, and it fails if the write is hoisted above the guard.

`_channel_from_payload` is defensive at every layer and returns `""`
rather than raising — `process_paystack_webhook`'s whole contract is
that it never lets an exception escape (`TenancyMiddleware` wraps the
request in one transaction, so an uncaught error would roll back the
`WebhookEvent` dedup row and silently defeat replay protection on the
next identical delivery). Losing a reporting label must never cost a
payment that is otherwise fine. The same reasoning truncates an
overlong value to the column width instead of failing the charge; both
cases have tests.

The field is a free `CharField`, deliberately **not** `choices`. This
is a value another company controls — `card` / `bank` / `ussd` /
`bank_transfer` / `mobile_money` / `qr` / `eft`, and whatever they add
next — and a choice-validated column that rejected an unrecognised one
would drop the very data the field exists to capture. Normalising into
reporting buckets is slice 2's breakdown.

**The trip times** are stamped in `transition_trip_status`, verified to
be the **sole** writer of `Trip.status` anywhere in the backend
(`TripStatusSerializer` and `_cancel_future_trips_for_schedule` both
route through it). Stamped only when still null, so a transition cannot
rewrite a time that already happened — `TRIP_TRANSITIONS` makes
returning to `in_progress` unreachable through the API today, but this
function trusts its caller to have checked that, and an analytics field
a future caller could silently falsify is worse than one that is
occasionally stale.

### The live channel verification, and what it showed about historical rows

A signed `charge.success` was delivered over real HTTP to the running
server against a pending intent, then read back through
`GET /payments/`:

```text
channel distribution across the page: {'': 17, 'ussd': 1}
```

Seventeen blanks and one capture — exactly the shape this spec's edge
case table predicts, and a reminder for slice 2 that `""` must report
as `unknown` and never be guessed at. Every row created for that check
was removed afterwards, including repairing the two `LedgerAccount`
`cached_balance` values the deleted journal entry had moved (a drift
sweep confirmed zero remaining).

### Not done, deliberately

- **Capturing the channel on `charge.failed`.** A failure-channel
  breakdown is plausible and unasked-for.
- **Backfilling either field.** Impossible for the channel; a lie for
  the trip times.
- **Arrival punctuality.** No scheduled *arrival* time exists anywhere
  in the model, so delay is measurable at departure only — this spec's
  own named gap, unchanged.

---

## Implementation note (Slice 2, done)

Built 2026-09-05. **860/860 backend tests** (up from 811 — 49 new),
1238 frontend unit tests unchanged, four clean builds, lint clean on all
nine projects, OpenAPI drift clean both directions, all four e2e
projects green. Every figure reconciled by hand against the real dev
database.

No UI: `ui-chart` and the dashboard are slice 3.

### A new app with no models

`apps/analytics` — `filters.py`, `services.py`, `serializers.py`,
`views.py`, `urls.py`, `tests/`. No `models.py` and no migration of its
own. The precedent is `apps/wallet`, a read layer over `apps.ledger`
with no model for the same reason.

### Three decisions taken with the user

1. **Money is reported net *and* gross.** `revenue` is the
   business-clearing total (what the operator is owed after Integra's
   commission — the ledger figure this spec mandates), with `gross` and
   `commission` beside it. "Revenue" alone is ambiguous on a transport
   dashboard, and an operator reading a gross figure as money they will
   receive is a real way to be misled.
2. **`?granularity=day|week|month`**, each with its own range cap
   (92 days / 1 year / 5 years). This is what makes this spec's own
   "400 asking for a coarser granularity" a sentence a caller can act
   on. `month` has no successor, so its message asks for a narrower
   range instead — asserted, because promising a granularity that does
   not exist is worse than the original error.
3. **A rolling 30-day default period.** Calendar-month alignment would
   show one point on the 1st.

### Gross without reading the commission account

The interesting constraint. `revenue` is the business-clearing lines,
which an ordinary Business's staff can see. `commission` lives on the
platform account, which has `client=None` and is **invisible** to them
under RLS — and a JOIN against an invisible row drops the referencing
row too, which is spec 5 Slice 1's recorded bug.

So gross is derived from the **debit side** instead: every payment
entry balances to zero, its negative lines are exactly the money coming
in (the PSP leg plus any wallet component), and `commission = gross -
revenue`. No reference to an account the caller cannot see, and no
`LedgerAccount` join anywhere in the module. A test asserts the staff
figure against an independently computed one taken under
`platform_staff_bypass()`, and asserts the commission is non-zero — so
it cannot pass by comparing two zeros.

### Two questions about the same rows, and the invariant that keeps them honest

The revenue endpoint scopes on the **journal entry's** `created_at` —
when the money moved. The payments summary scopes on the
**PaymentIntent's**, exactly as `GET /payments/` does, because it sits
above that table and its whole job is to describe those rows. They can
differ marginally at a period boundary, and each is right for its own
screen.

`GET /payments/` now filters through the same
`apps.analytics.filters` module rather than its own hand-written chain.
That shared path is the point: a divergence between the strip and the
table is now one bug to find, not two.

### A real inconsistency, found by an invariant test

`money.collected` includes wallet top-ups (it must — the table below it
lists them), but the channel breakdown excluded them (it must, for
revenue: funding a balance is not revenue). The two were rendered side
by side and did not add up — a 300.00 gap in the fixture.

Caught by asserting the property directly rather than by checking
example values: **the channel amounts always sum to the total they are
rendered beside.** Fixed with an explicit `include_topups` flag so the
two callers scope the same breakdown differently and on purpose.

That invariant has a consequence worth knowing: filtering to
`channel=card` still shows a `wallet` slice when one of the selected
payments was blended. That is not unfiltered data leaking in — the
filter selects *payments*, and the breakdown decomposes the payments it
selected by the methods they actually used. Suppressing it would break
the sum.

### The live reconciliation, and the mistake it exposed in the tests

Reconciled by hand against the dev database, comparing
`/analytics/revenue/` with `GET /ledger/entries/` and
`/analytics/payments/summary/` with `GET /payments/`:

```text
BUSINESS: Integra E2E Network Test Business (NGN)
  analytics : revenue=2850.00 gross=3000.00 commission=150.00 over 4 payments
  ledger    : net=2850.00     gross=3000.00 over 4 payment entries
```

The first parity run reported a 50.00 gap — which turned out to be the
**checker's** error, not the endpoint's: it summed `PaymentIntent.amount`
alone, and that is the Paystack leg only, with the wallet half in
`wallet_component_amount`. A blended payment is only whole when both are
added.

The unit test made the identical mistake and passed only because its
fixture had no blended payment. It now creates one, and asserts the
blended row is genuinely split — so it would fail if the summary ever
dropped the wallet leg.

### The permission nobody had

Slice 1 seeded `analytics.view` and added it to `DEFAULT_ROLE_PERMISSIONS`.
That only affects roles created *afterwards*, so on the real database
it had reached **4 of 307 Owner roles**. These four endpoints would have
shipped 403-ing for almost every existing Owner and Manager.

`identity/migrations/0019_grant_analytics_view_to_existing_roles.py`
fixes it — additive only, Owner and Manager, never Staff. Safe because
`create_default_roles` already calls `role.permissions.set(...)` on
every registration and no endpoint anywhere edits a role's permissions,
so there is no customisation to clobber. Verified live: 4/307 → 307/307
on both presets, Staff untouched at 0/307.

**The first version of that migration silently did nothing.** `Role` is
a `BaseModel`, so it carries an RLS policy that fails closed, and a
migration has no `app.current_client_id` set — every `SELECT` returned
zero rows and the migration reported `OK`. Fixed with
`set_rls_session_vars(None, is_platform_staff=True)` plus `all_objects`,
the pattern `businesses/0010_backfill_booking_mode_axes.py` established.
Every prior seed migration escaped this only because `Permission` is not
a `BaseModel`.

### A systemic gap, named rather than fixed

The same mechanism has left **every** codename added after Phase 1
missing from roles that predate it. Measured on the dev database:

```text
client.view          307/307 Owner roles
booking.view         186/307
ledger.view          177/307
payments.view        177/307
ticketing.validate   170/307
notifications.view   168/307
analytics.view         4/307   (before this slice)
```

Reconciling all of them is a one-line generalisation of the migration
above, but it is a real access change across six other features, so it
is left as its own decision rather than smuggled into this slice.

### Not done, deliberately

- **Every screen** — slice 3 (`ui-chart` + dashboard) and slice 4
  (revenue, transactions, performance).
- **Export** and its row cap — slice 4. This slice's parity test is
  therefore two-way (summary ↔ list) rather than this spec's three-way;
  the export joins it in slice 4.
- **Incidents.** Spec 17 owns the model. The dashboard's `incidents`
  key reports zero and is present now on purpose — adding it later
  would be a breaking envelope change for a frontend already reading
  the shape.
- **Pre-aggregation.** Everything is computed at query time, with this
  spec's own p95 trigger left as the thing to watch.

---

## Implementation note (Slice 3, done)

Built 2026-09-05. **861/861 backend tests** (up from 860), **530
`client-admin-app`** unit tests (up from 496) and **326 `shared-ui`**
(up from 305) — 1272 frontend unit tests in total. Four clean builds,
lint clean (0 errors) across all nine projects, OpenAPI drift clean both
directions, and all four Playwright projects green: client-admin-app 90,
customer-app 18, super-admin-app 19, validator-app 7. §10.6 visual loop
run over three iterations — `docs/ui-review/16-operational-analytics/`.

`ui-chart` and the dashboard, as scoped. No new endpoint: everything on
the screen comes out of `GET /analytics/dashboard/`, in one request.

### `ui-chart` renders SVG, not `chart.js`

This spec named `chart.js`/`ng2-charts` behind the component, with the
stated goal that the dependency stay contained and swappable. It is
built with **no charting dependency at all**, which serves that goal
more completely — and two things about this system made the choice
concrete rather than a preference:

1. **Tenant brand colour.** Chart colours are required to come from
   spec 14's tokens so a white-labelled operator's charts match their
   brand, and `BrandThemeService` writes `--color-brand-*` onto the
   document at runtime, per Client. A canvas `fillStyle` cannot hold
   `var(--color-brand-600)`; it needs the token resolved to a literal
   with `getComputedStyle` at draw time and **re-resolved whenever the
   brand changes**. That is a silent-staleness trap of exactly the kind
   this repo keeps recording. In SVG, `stroke="var(--color-brand-600)"`
   tracks the variable for free, including a mid-session change.
2. **The drawing is decorative.** A canvas is opaque to assistive
   technology, which is why this spec already requires a parallel data
   table beside every chart. Given that table, the picture carries no
   information of its own — and a decorative picture is not worth a
   runtime dependency, a Karma canvas harness, or ~200kB in the bundle.
   The whole lazy `dashboard` chunk is 21.8kB.

The containment intent is unchanged: `chart.ts` is still the only place
any chart is drawn, and swapping it for a library later means rewriting
one component against the same inputs.

Line, bar and doughnut, each with a visually-hidden `<table>` captioned
with the chart's title and an `aria-hidden` `<svg>`; a legend that names
every series beside its swatch, so colour is never the only carrier; and
`value: null` as a **gap, never a zero**, which breaks the line rather
than bridging it.

### Two real backend bugs, both from slice 2, both found by building this

**Every money field on all four analytics endpoints shipped as a JSON
float.** These endpoints return plain dicts, so nothing coerces their
values the way a `ModelSerializer` field would: a bare `Decimal` reaches
DRF's JSON encoder and leaves as a number. Meanwhile the schema-only
serializers — which document the responses but never render them —
declare `DecimalField`, so the generated `schema.ts` said `string`. The
frontend's `formatMoney` takes a decimal string and rendered
`NGN 2850` for `2850.0`: cents dropped, with the type system asserting
it could not happen. Fixed with an emission boundary
(`_money`/`_rate` in `apps/analytics/services.py`), and guarded two
ways — `as_decimal()` in the test helpers asserts the string before
converting at every money assertion in the suite, and one new
structural test walks the entire dashboard envelope asserting every
money-shaped key is a string that quantizes to 2dp, so a future
aggregate gets the check for free.

**Every 400 these endpoints answer is field-keyed, not `{"detail": …}`.**
`AnalyticsFilterSerializer` produces `{"date_from": [...]}` and
`{"granularity": [...]}`. The dashboard store's first error extractor
read `detail` alone — a guess — and flattened a message naming the exact
fix ("Use granularity=week for a longer range") into a generic "Failed
to load the dashboard." Found by calling the running backend, not by
reading the code. Both shapes are handled now, with unit tests for each.

### One real frontend bug, found only by Playwright

**Overlapping requests could leave the screen showing an older
answer.** Filling two date fields in a row issues two requests, and they
do not return in order: a validation 400 comes back almost immediately
while a real aggregation takes as long as it takes. Sent A then B, the
screen rendered A's *successful* dashboard with no error at all, while
the period line under the filter bar quietly disagreed with the two date
fields above it. On a screen whose entire job is to be trusted, that is
the worst available failure. Fixed with a monotonic request id in
`AdminDashboardStore` — only the newest response may write, and
`loading` stays true until it settles. Two store tests drive the
out-of-order case explicitly.

### The route stays gated on `client-admin:access`

`/home` is where **every** client-admin user lands after signing in, and
the Staff preset deliberately does not carry `analytics.view` (slice 1's
own decision: revenue totals are a different sensitivity from the
operational lists Staff needs). Gating the route on `analytics.view`
would drop a Staff user on the Forbidden page immediately after a
successful login. The route keeps its original guard and the component
asks for the codename itself: with it, the analytics; without it, a
named empty state and **no request at all**.

`home/` is deleted and `dashboard/` takes its place at the same path, so
every landing redirect keeps working. The nav item is renamed
`Dashboard` with a new `chart-bar` icon — a house glyph named the route
rather than the screen — which is why `login`, `register`,
`nav-collapse` and `businesses` e2e specs changed: they asserted the old
screen's content (the signed-in email in the heading, "You have
client-admin-app access."), which no longer exists. Account identity
lives in the profile menu, which `profile-menu.spec.ts` already covers.

### Trend gaps are reconstructed client-side, and defer to the server

The endpoints emit only buckets that have data. To draw a gap rather
than a zero the client has to put the empty buckets back, so
`client-admin-app/src/app/shared/trend-buckets.ts` expands the period
into its buckets and marks the missing ones `null`.

Two things are load-bearing there. All arithmetic is **UTC**
(`Date.UTC`/`getUTC*`): a plain `new Date('2026-08-01')` is UTC
midnight, so reading `getDate()` off it in any negative-offset timezone
yields July 31 and the entire axis shifts a day. And week buckets start
on **Monday**, matching Postgres `date_trunc` and therefore Django's
`TruncWeek`, which produced the dates on the other side. If the
expansion and the server ever disagree — any returned date falling
outside the derived axis — **the raw points are returned untouched**: an
axis this got wrong would silently drop real data, which is far worse
than a chart that merely fails to show gaps.

### Not done, deliberately

- **Slice 4** — revenue, transactions and per-trip performance screens,
  plus `GET /exports/{resource}/` and its row cap. The three-way parity
  test this spec asks for is still two-way until the export exists.
- **`ui-chart` has no tooltips, no axis tick labels between the first
  and last category, and no animation.** The accessible table carries
  every value exactly, which is what a tooltip is for; ticks inside a
  non-uniformly stretched plot would distort, and the component
  deliberately draws no text inside it.
- **The permission-grant backlog.** `identity/0019` repaired
  `analytics.view` only. The six older codenames measured in slice 2's
  note are still short, and reconciling them remains its own decision.

---

## Implementation note (Slice 4, done)

Built 2026-09-05. **This closes spec 16.** 920/920 backend tests (up
from 861), **568 `client-admin-app`** unit tests (up from 530) and 329
`shared-ui` (up from 326) — 1313 frontend unit tests. Ruff, mypy (301
files), OpenAPI drift clean both directions, four clean builds, lint
clean on all nine projects. All four Playwright projects green:
client-admin-app 105, customer-app 18, super-admin-app 19,
validator-app 7. §10.6 visual loop over two more iterations —
`docs/ui-review/16-operational-analytics/iteration-5.md`.

Three screens (revenue, transactions, per-trip performance) and
`GET /api/v1/exports/{resource}/` — the first non-JSON response this
backend has returned and the first file download this frontend has
performed.

### The export is not a `StreamingHttpResponse`, deliberately

This spec's own text says it is. **It must not be**, and
`apps/analytics/exports.py`'s module docstring carries the full argument
so the next reader does not "fix" it.

`TenancyMiddleware` wraps each request in its own `transaction.atomic()`
and resets the Python tenancy contextvars in a `finally`. A streaming
response object returns to the WSGI server immediately — so by the time
its body is iterated the transaction has committed (taking the
transaction-local RLS session GUCs with it) and the contextvars are
already reset. A generator running querysets lazily would execute every
one with **no tenancy context at all**: RLS fails closed,
`TenantScopedQuerySet` returns `self.none()`, and the operator downloads
a silently empty CSV that reports `200 OK`.

Rebuilding tenancy inside the generator was considered and rejected — it
duplicates `TenancyMiddleware`, holds a transaction open for as long as
the client's network takes, and risks leaking a contextvar onto a pooled
worker thread on an aborted download. Everything is materialised inside
the view instead, bounded by `EXPORT_MAX_ROWS`, and returned as a plain
`HttpResponse`. Read in context, this spec's "streams" means *the whole
filtered set rather than one page*, which is preserved exactly.

Laziness is made structurally impossible rather than merely absent, and
three of the four guards fail at build time: `ExportSpec.rows` is typed
`-> list[...]` (a generator function does not satisfy it),
`RenderedExport.body` is a `str`, `ExportView.get()` is annotated
`-> HttpResponse`, and `test_export_materialisation.py` walks the
registry with no allowlist asserting **zero queries run while the body
is read**.

### Four real bugs found, three of them shipped

**1. `GET /payments/` had been truncated to 30 days since slice 2.**
That slice pointed the payments list at the *aggregate* filter function,
which applies the rolling default period. From then until now, a support
and dispute screen showed only the last month — a payment from two
months ago simply was not there, with no chip, no message and no error.
It went unnoticed because every fixture and every row in the dev
database was recent, and it was found only when the bookings list was
about to inherit it.

The fix names the distinction rather than patching one caller: an
**aggregate** is always bounded (a dashboard with no period is
meaningless), a **record list** is bounded by its own pagination and its
export by the row cap. `apply_to_payment_records`/`apply_to_booking_records`
are where that lives, and the list endpoint and the export of the same
rows call the identical function — which is what makes "export current
view" true rather than aspirational.

**2. Every export 500'd in local development while every test passed.**
`config/settings/local.py` **replaced** `DEFAULT_THROTTLE_RATES` rather
than merging it, so the new `export` scope did not exist under
`config.settings.local` and DRF answers an unknown scope with
`ImproperlyConfigured`. `config.settings.ci` inherits base's rates, so
the suite never saw it. Found on the first real HTTP call. Fixed at the
root by spreading base's dict first, so **the next scope anyone adds is
inherited automatically**.

**3. Two analytics tests passed every morning and failed every
evening.** Trip counts narrow on `service_date`, and the shared fixture
seeds a departure a few hours out — which lands on *tomorrow* when the
suite runs late in the day, outside a default window ending today. One
of them (`test_counts_break_down_by_status_rather_than_totalling`) is
slice 2's and had been latent since; the other two were slice 4's own.
All three now name their period explicitly.

**4. The trip-list link cost the table 16px at 390px.** Caught by
`e2e/responsive-tables.ts`. `ui-table` resets `overflow-wrap` inside a
`<button>`/`<a>` so a control label is never split, but this link's text
is the route name, which is data. The fix is on a `<span>` inside the
anchor, because a utility class on the anchor itself loses to that
`::ng-deep` selector's specificity.

### `GET /bookings/` migrated onto the shared filter module

Its own `BookingListQuerySerializer` meant a bookings export would have
honoured `business` alone — a status-filtered screen would have exported
every status, silently. And `?status=paid` would have 400'd once it
adopted the shared set, because that `status` is validated against
*PaymentIntent*. So the filter set gained a separate **`booking_status`**
dimension: one field validated against two enums cannot validate either.
`trip` and `search` stay local, the way `search` already does on
payments.

### Seven resources, not the spec's six

`transactions`, `bookings`, `revenue`, `revenue-trend`, `route-revenue`,
`trip-class-revenue`, `trip-performance`.

- **`incidents` is not built.** Spec 17 owns the model; an endpoint that
  can only ever return an empty file is worse than a 404, and adding a
  resource later is purely additive.
- **`revenue-trend` and `trip-class-revenue` were added.** Everything
  the revenue screen renders is exportable, and the per-bucket trend —
  the one genuinely row-shaped thing on that screen — was the obvious
  omission. Both reuse existing service functions.

Two column names are deliberate divergences, each preventing a specific
misreading:

- **`total_paid`** is its own column on `transactions`.
  `PaymentIntent.amount` is the Paystack leg only, and slice 2's live
  reconciliation *and* its first unit test both read it as the whole
  payment. A spreadsheet reader summing one column must not be able to
  make that mistake.
- **`gross_amount`**, not `amount`, on the two dimension breakdowns.
  `breakdown_by` returns gross while the `revenue` file's own `revenue`
  column is net, and two downloaded files with a column called `amount`
  meaning different things is exactly the plausible wrongness this spec
  exists to prevent.

### `trip_performance_rows` is set-wise

`trip_performance(*, trip)` is five to seven queries **per trip**; at the
row cap that is several hundred thousand. The export's twin is **six
queries regardless of row count**, using subqueries rather than
materialised id lists, and a `django_assert_max_num_queries` test fails
on any reintroduced N+1. It reuses `apps/ticketing/capacity.py` for its
*semantics* (`is_open_seating`, `OCCUPYING_STATUSES`) rather than its
queries, and a test asserts equivalence with `get_capacity` directly
rather than trusting the reasoning that its whole-trip window makes the
overlap predicate a no-op.

### The file is a customer list

Passenger id, email **and** name are carried, which makes a saved export
a customer list rather than an opaque one. Two consequences are in
scope: every export writes an `AuditLog` row (`analytics.export`, with
the resource, row count and resolved period), and `Cache-Control:
no-store` — free from `NoStoreApiMiddleware` — is why a shared machine's
browser cache does not keep another operator's customers. The filename
is built from a fixed alphabet with no operator-entered text in it, and
says `-all` rather than naming a period the file does not respect.

### Three things the frontend needed that had no precedent

- **`parseAs: 'blob'`**, per call — openapi-fetch defaults to JSON and
  would call `.json()` on a CSV body.
- **The error body is a blob too**, so recovering the `detail` an
  operator can act on means reading it back as text and parsing it.
  Without that, every refusal reads as a generic failure.
- **`CORS_EXPOSE_HEADERS`** — a browser will not let the app read
  `Content-Disposition` cross-origin otherwise, and the download would
  succeed under the wrong filename. The SPA runs on :4201 and the API on
  :8000, so this is not a production-only concern.

The download goes through the **typed** client, which is why the
endpoint is documented rather than `exclude=True`: a raw `fetch` with a
hand-attached header would bypass `authMiddleware`'s 401
refresh-and-replay and re-create the stale-token bug
`docs/specs/13-session-resilience.md` records. `OpenApiResponse` with a
`(status, media_type)` tuple key is this repo's first, and generates a
**union type for the resource path parameter**, so a typo is a compile
error rather than a runtime 404.

### Two extractions, each on the third copy

- **`PeriodFilters`** (`shared/period-filters.ts`) — the date range,
  granularity, chips and URL round-trip the dashboard hand-rolled in
  slice 3 and both new screens needed identically. The dashboard was
  refactored onto it, so there is one implementation.
- **`AnalyticsEnvelopeStore`** — the loading/error/data trio *and* the
  monotonic request counter that discards out-of-order responses.
  `AdminDashboardStore` keeps its own copy, being the only one with a
  hand-written envelope type.

### Not done, deliberately

- **`incidents`**, above.
- **XLSX, PDF, JSON.** Excel opens this CSV; the rest is speculative.
- **Scheduled or emailed reports.** An export is a synchronous download
  the operator asks for.
- **Pre-aggregation.** Still query-time, with this spec's own p95
  trigger left as the thing to watch.
- **The permission-grant backlog.** `identity/0019` repaired
  `analytics.view` only; the six older codenames measured in slice 2's
  note remain short, and reconciling them is still its own decision.
