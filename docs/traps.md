# Traps and known gaps

Concrete lessons, not concepts — file names, symptoms, fixes. `CLAUDE.md`
points here rather than carrying this list itself: it is reloaded every
session and every compaction, and this file is not. Read this when
you're about to touch an area with a recorded trap; `docs/status.md` has
the full account of every one, this is the one-liner you need at the
keyboard.

**Adding one:** a trap belongs here when it cost real debugging time and
is specific enough to search for (a class, a file, a symptom) — not a
general principle (those belong in `CLAUDE.md`'s "How we work"). Put the
one-liner here and the full reasoning in `docs/status.md`, same split
`CLAUDE.md` itself uses.

## Never do these

- **Never run a formatter over this repo.** There is no `prettier`
  dependency and no config; `npx prettier --write` once rewrote 156
  files. Format by hand; `ng lint` is the gate.
- **Never use the `integra` Postgres role.** It is a bootstrap superuser
  that bypasses RLS unconditionally, so everything looks correct for the
  wrong reason. Use `integra_app`. To read RLS-protected tables in
  `psql`: `SET app.is_platform_staff = 'true';`
- **Never hand-attach an `Authorization` header** anywhere in the
  frontend. `authMiddleware` owns it (see spec 13); a header captured
  before a refresh goes out dead. The single exception is
  `AuthApiService.fetchCurrentUser`.
- **Never write `queryset = Model.objects.all()` as a class attribute**,
  on a view or as a serializer field's `queryset=`. Both are evaluated
  at import time and freeze empty forever.
- **Never join `LedgerAccount` from an aggregate.** The platform
  commission account has `client=None`, so the JOIN drops the
  referencing row too for ordinary Business staff.
- **Never let anything in the Paystack webhook path raise.** It runs
  inside `TenancyMiddleware`'s single request transaction, so an
  uncaught error rolls back the `WebhookEvent` dedup row.

## Backend traps

- **`Meta.ordering` is not inherited** by a subclass that declares its
  own `Meta`. `identity.Role` and `identity.User` shipped unordered
  pagination through this.
- **RLS fails closed.** Anything outside an HTTP request — a management
  command, a Celery task, a data migration — must call
  `set_rls_session_vars(...)` inside a transaction, or use
  `platform_staff_bypass()`, and read `.all_objects`.
- **`identity.User` is not tenant-scoped** (ADR-0003). Any serializer
  taking a user id must filter `client=` explicitly.
- **A spec can name fields that do not exist.** Spec 18's envelope
  assumed a `Booking.reference` and a `Ticket.reference`; neither did,
  and its slice-2 lookup then assumed a `User.phone`, which also does
  not. Check the model before planning around it.
- **A spec can also name a data flow that doesn't exist yet.** Spec
  20's activity feed assumed a PAYG fare deduction posts a ledger entry
  against the passenger's wallet — traced through
  `apps.tapngo.services._record_alight` and confirmed it does not
  (closing a `FareJourney` only stamps `amount`/`currency`; nothing
  calls `post_journal_entry`). Different from a missing field: the
  fields all exist, the *write* the spec assumed happens elsewhere
  simply never runs. Named as a real, separate gap in the
  Implementation note rather than silently fabricated.
- **A filter that excludes nothing is not a result that includes it.**
  The manifest's "`pending_payment` is deliberately not excluded" was
  true of the filter and false of the output: it queried `Ticket`, and a
  ticket only exists after payment. Assert the invariant, not the
  example — the test that missed it made a ticket first.
- **Check that a gating codename is reachable before building a control
  that needs it.** `GET /staff/` is gated on `staff.manage`, which only
  Owner holds — an assignee picker built on it 403s for every Manager
  and Staff user. `GET /incidents/assignable-users/` exists because of
  exactly that.
- **A seed migration grants a codename to nobody who already exists.**
  Every new codename needs a grant migration alongside it
  (`identity/0021` is the pattern) or it ships 403-ing for every
  existing Client.
- **A value derived for one screen is not right on every screen.**
  `passenger_report_title` keeps the operator queue's first column from
  being blank; on the reporter's own screen it printed the category
  twice.
- **A record list must not inherit an aggregate's default period.**
  Lists are bounded by pagination; aggregates are always bounded.
- **One field cannot be validated against two enums.** Name them apart
  (`status` vs `booking_status`).
- **A lazily-produced response body runs with no tenancy context** —
  `TenancyMiddleware` resets contextvars when the view returns, so a
  `StreamingHttpResponse` hands back a silently empty file, 200 OK.
- **A settings override that replaces a dict hides every later addition
  to it.** `local.py` merges `DEFAULT_THROTTLE_RATES`; keep it that way.
- **A plain-dict endpoint does not coerce `Decimal`** — it leaves as a
  float while `schema.ts` says string. Render rows through the
  serializer the schema is built from.
- **`ListField(child=DictField())` generates an untyped bag** — two row
  shapes in one envelope want a `PolymorphicProxySerializer`.
- **Declare a required filter on the spec, not inside the row builder**
  (`ExportSpec.required_filters`), so registry-driven tests supply it
  rather than excluding the resource and losing its coverage.
- **Name any new colliding OpenAPI enum** in
  `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]`; otherwise the generated
  type name is a hash of the choice set and renames itself when the enum
  grows.
- **Capacity counts issued tickets only.** Unpaid bookings hold nothing,
  so a departure can oversell; the `Trip` row lock gives a consistent
  count plus a `trip.oversold` audit record, not prevention. **There is
  no refund service**, so acting on one is manual.
- **The fare wildcard is `""`, never NULL** — Postgres `=` does not
  match NULL to NULL, and `get_fare()`'s `order_by("-trip_class")` only
  works descending.
- **A model field that exists is not the same as a model field that is
  written.** `KybDocument`/`KycDocument` carried `status`, `reviewed_by`
  and `reviewed_at` since their first migration; `decide_business_kyb`
  and `decide_client_kyc` set the parent's `kyb_status`/`kyc_status` and
  never touched them, so an approved business rendered every document
  `pending` forever (self-check 2026-08-26's F10, closed 2026-09-07).
  Both now bulk-update the still-`pending` documents inside the same
  locked transaction — scoped to `pending` only, so a document decided
  in an earlier rejected round keeps its own history rather than being
  relabelled by a later approval.
- **An additive-then-later-drop migration plan must relax the old
  column's constraints in the additive step, not just leave it
  present.** Spec 19's plan added `status` and stopped there, reasoning
  the `is_active` drop was "a separate, later, explicitly-approved step"
  with "no pressure to run in the same deployment." False the moment
  `Route.objects.create()` stopped setting it: the column was still
  `NOT NULL` from migration 0001, so every new Route insert on any
  database that had applied the additive migration but not the drop
  failed `IntegrityError`. Every `pytest` run stayed green throughout —
  `--create-db` builds the test database from *every* migration
  including the drop, so the constraint never exists there to violate.
  Found only by running the golden path against a real database
  (docs/specs/19-route-lifecycle.md's own Implementation note). Fixed by
  making the old column nullable in the *same* additive migration.
- **`CORS_EXPOSE_HEADERS` gates what JavaScript can read, not what the
  server sends.** `GET /trips/live/`'s `ETag` (spec 20) reached the
  browser on every response, but `response.headers.get('etag')` read
  `null` cross-origin until it was added to `CORS_EXPOSE_HEADERS` —
  `Content-Disposition` had already been added for the same reason one
  spec earlier. A client-visible response header a frontend needs to
  *read back* (not just receive) always needs this, and it is easy to
  ship a poll/cache mechanism that "works" in a same-origin manual check
  and silently never short-circuits once deployed.
- **An `@extend_schema`'d view's manually-validated query param still
  needs its own `OpenApiParameter`.** `TripsLiveView` read `?since=`
  from `request.query_params` correctly from slice 2, and the backend
  test suite covered it — but nothing declared it to drf-spectacular, so
  `schema.ts` typed the endpoint as taking no query at all and the
  typed frontend client could never send it. A parameter absent from
  `parameters=[...]` is invisible to every consumer of the generated
  client, however correctly the view itself handles it.

## Frontend traps

- **`ui-text-field` / `ui-select` render an error only when the parent
  binds both `[invalid]` and `[errorMessage]`.** Assert *rendered*
  validation output, never just "the POST didn't happen".
- **Use `ListStore.findByIdPaged`** for any detail/edit screen, passing
  the scope explicitly. Never `this.query()`, and never a bounded fetch
  plus `.find()`. **Unless the domain has a real single-record GET** —
  `apps/incidents` does, and calling it costs one request instead of up
  to fifty. Check before reaching for the paged lookup.
- **A `computed()` over a plain form-control value depends on no
  signal** and caches its first result forever. Use
  `toSignal(control.valueChanges)`.
- **An `effect` that calls a store must wrap the call in `untracked()`.**
  Signal reads inside the store method become that effect's
  dependencies, so the store's own write re-triggers it — an infinite
  *synchronous* loop that freezes the tab rather than erroring. It
  presents as `page.url()` answering instantly while `page.evaluate`
  times out.
- **Narrowing a `<select>`'s options does not move the value into
  them** — reconcile in an `effect`.
- **`patchValue` applies an explicit `undefined`.** Guard with
  `?? <default>`.
- **Assert a control shows what it will submit.** A `<select>` whose
  initial value was not the first option displayed the first one
  while submitting the real one — fixed in `ui-select`, but it had
  already shipped in three forms and no test noticed.
- **A store that refetches on filter change needs a monotonic request
  id**, or an older success lands after a newer failure.
- **`ui-toggle` and `ui-select` hints reach sighted users only** unless
  wired through `describedBy` / `aria-describedby`.
- **`ui-form-section` renders a labelled region** — never name one so
  it contains a control's own label ("Which trip" around "Trip"); both
  get announced, and `getByLabel` matches both.
- **An id or date in a table cell needs `whitespace-nowrap`** — but
  not a phrase: "Open seating" held on one line pushed a table 3px
  past 390px.
- **`e2e/responsive-tables.ts` only measures screens it can reach** — a
  table behind a resolved id needs a path *resolver* there, or it is
  silently uncovered.
- **Adding a table?** Follow `ui-table`'s responsive-column convention —
  the `hidden md:table-cell` class goes on the `<th>`, its `<td>` *and*
  the skeleton `<td>`. Call `expectColumnVisibilityParity` from the
  spec. (customer-app writes no skeleton `<td>`s — `ui-table`'s
  `[loading]` swaps the whole table for a message.)
- **A link whose text is data needs `[overflow-wrap:anywhere]` on a
  `<span>` inside the anchor**, not on the anchor.
- **Placeholders that carry information need `placeholder:text-muted`** —
  Tailwind's default measures 2.64:1.
- **`ui-chart` draws SVG; there is no charting dependency.** Every chart
  renders a visually-hidden data table beside an `aria-hidden` `<svg>`.
  Nothing inside the plot may rely on geometry, and a `null` is a gap,
  never a zero.
- **Downloads go through the typed `API_CLIENT`** with `parseAs: 'blob'`;
  the error body is a blob too. `ExportStore` is the one implementation.
- **`imports: [DatePipe, ...]` only registers a pipe for template
  `| date` syntax — it does not make `inject(DatePipe)` resolvable.**
  Hit twice building spec 20 (`live-operations.ts`, then
  `trip-tracking.ts`): a component that calls `DatePipe` programmatically
  (formatting an ETA outside the template) needs `providers: [DatePipe]`
  on the `@Component` decorator instead, or DI throws at runtime with no
  compile-time warning that anything is wrong.
- **A UMD/CJS package's dynamic `import()` resolves differently under
  Karma than under an app's production build.** `ui-map`'s
  `await import('leaflet')` came back as a plain namespace with no
  usable `.default` in the app builds' esbuild output, but as a
  namespace with `.default` set under Karma's build target — the
  opposite of what either alone would suggest is safe. Unwrap
  defensively (`imported.default ?? imported`) rather than trusting
  either shape.
- **`jasmine.clock()` alone does not flush a pending microtask
  continuation** — `setTimeout(fn, 0)` still needs an actual clock
  advance, and code after an `await` inside a timer callback runs as a
  microtask the fake clock never touches. `Poller`'s own spec uses
  Angular's `fakeAsync`/`tick()` instead, which drains both in one call;
  a bare `jasmine.clock()` produced "called 0 times" on assertions
  immediately following a `start()` that, in the real browser, had
  already run synchronously.

## Testing traps

- **If a large number of unrelated tests fail in a permission/tenancy
  shape, run `pytest --create-db` first.** A `transaction=True` test
  flushes the reused database including `RunPython`-seeded data.
- **Run every Playwright project, with `--project=`.** A bare run fails
  three specs that pass per-project, because suites share fixtures.
- **Reseed before believing a failure.** Several e2e specs are
  single-use per seed (`validate-ticket`'s open-seating case,
  `super-admin`'s `kyc-queue`). `kyc-status`'s axe check is instead
  **load-sensitive** (a fading disabled button) — retry at
  `--workers=2` before calling it a defect.
- **Never take a fixture off the first row.** It breaks once a new
  writer shares the Business (search for it instead), and the earliest
  departure on a route is a Celery-generated trip with **no vehicle** —
  `not_configured`, no seat map, and only in search results before it
  departs, so a booking spec passes all afternoon and fails at 07:20.
- **`await locator.count()` does not retry; `expect().toHaveCount()`
  does.** Nor does `locator.isVisible()` — use
  `expect().toBeVisible()` when probing for something still loading.
- **Name the period whenever a test asserts a trip count** — trip
  filters narrow on `service_date`, and a fixture departing hours from
  now lands on tomorrow in the evening.
- **Assert the invariant, not the example**; and assert a *property*
  rather than a magic query budget.
- **A visual capture that looks merely empty is the harness losing its
  active Business.** `e2e/session.ts`'s `selectBusinessByName` throws on
  a failed response now; it used to return silently and photograph a
  whole pass of the wrong Business. Compare a known-populated screen
  across widths before believing a new screen is broken.
- **Read a `prune_e2e_test_data` dry run before running it** — it cannot
  distinguish fixtures from real work done under the e2e account, and it
  structurally cannot clear the KYB/KYC queues.
- **`settings.SETTINGS_MODULE` reads `None` under any active settings
  override — including this repo's own autouse `settings` fixture,
  active on every single test via `conftest.py`.** Django's
  `UserSettingsHolder` (what `settings._wrapped` becomes under any
  override) hardcodes that one attribute to `None` at the class level.
  A dev/CI-only command guard (spec 20's `simulate_vehicle_positions`)
  must read `os.environ["DJANGO_SETTINGS_MODULE"]` instead — untouched
  by settings-wrapping, and the same env var Django's own
  `ManagementUtility` resolves the module from.
- **A fixture route with `Stop.latitude`/`longitude` both `None` is
  invisible to anything GPS-shaped, silently.** Every route
  `seed_e2e_users` seeded before spec 20 slice 3 had uncoordinated
  stops, so `simulate_vehicle_positions` skipped every one of them and
  reported it (`skipped_routes`) — but nothing was reading that count,
  so the live-operations e2e spec would have had zero vehicles to find
  and no obvious reason why. `OPEN_SEATING_STOP_COORDINATES` makes
  "Yaba → Lekki" the fixture suite's one coordinated route; a spec
  needing real device-shaped data uses that route, not a new one.
- **A shared fixture "passenger" makes "someone else's trip" hard to
  construct for a negative e2e test.** `seed_e2e_users` reuses the same
  passenger across almost every fixture flow, so by the time a spec
  runs against an accumulated dev database that passenger genuinely
  holds a ticket or fare journey on nearly every route in it — spec 20
  slice 4's own "not found" test picked a route on the assumption
  nothing was held there and failed once real accumulated history said
  otherwise. A random, syntactically-valid UUID is the reliable
  stand-in: `Trip.objects` being tenant-scoped already makes an unknown
  id 404 by construction, which is the behaviour actually under test.
- **A status transition that targets the status already held is a
  no-op success, not an error** —
  `TripStatusSerializer.validate`'s own first check. Useful for an e2e
  fixture transitioned across repeated runs of the same spec against a
  database that isn't re-seeded in between: POST the target status
  unconditionally rather than GETting the current one first (there is
  no single-trip GET endpoint to do that with anyway — only the list).

## Known gaps, deliberate and open

- **Both consumer navs are one link from wrapping** — measure before
  adding one, and note `w-full` resolves against the nearest flex
  parent, not the header (validator-app's nav was 193px, not 358, for
  two slices). Spec 21 owns replacing the passenger bar with a bottom
  tab bar; keep labels short rather than pre-empting that.
- **A picker that fetches one bounded page cannot reach every row.**
  `booking-list`'s trip dropdown was the recorded case and is **gone**
  (spec 14 slice 3b replaced it with server-side search, and its e2e
  test is green); `SelectedBusinessStore` pages in a loop. Still
  one-shot at `limit=100`: `BusinessOptionsService`.
- **Django admin cannot read RLS-protected models** — an admin request
  authenticates by cookie, resolves as anonymous, and sees zero rows.
- **Production reverse-proxy topology for white-labeled custom domains**
  is documented but unbuilt, as is AWS provisioning and S3 media
  storage.
- **Botswana has no PSP** — Paystack does not operate there (ADR-0007).
- **Naming, settled and not to be "fixed":** the *credential* is Tap &
  Go; the *fare model* is Pay as you go; the `/tap-go` route path stays.
- **The KYB queue has no search** (self-check 2026-08-26's F7,
  reconfirmed 2026-09-07) — 25 near-identical rows per page, no filter.
  New functionality, not a bug; nobody has asked for it yet.
- **`prune_e2e_test_data` cannot clear the KYB/KYC review queues**
  (F8) — `KybDocument`/`KycDocument`'s FK is `on_delete=PROTECT`, and a
  queue row has a document by definition, so it can never be pruned.
  Structural; the queues grow monotonically with every e2e run.
- **The four Playwright projects interfere when run without
  `--project=`** (F6c) — `super-admin`'s `kyc-queue` spec and
  `client-admin`'s `kyc-status` spec share one KYC fixture; the booking
  specs contend for the same fixture seats. Green individually, not
  together. Not fixed — needs per-project fixtures or a global serial
  ordering.
