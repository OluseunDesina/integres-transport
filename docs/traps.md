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
- **A backtick inside an HTML comment inside a component's template
  literal ends the literal early.** `app-shell.ts`'s template is
  itself a JS template string; a docstring-style comment quoting
  `` `pb-[env(...)]` `` and `` `main` `` the way this file's own prose
  does closed the string at the first backtick and produced cascading
  `TS1005`/`TS1109` syntax errors several lines later, at the point the
  now-unterminated string finally found a real backtick to pair with —
  nowhere near the actual mistake. Quote class names and identifiers in
  template comments with plain quotes instead.
- **`break-words` on a heading does nothing if its flex-item ancestor
  has no `min-w-0`.** A flex item's default minimum width is its
  content's own min-content size — for wrapping prose, the width of its
  single widest *unbreakable* run — so without `min-w-0` the ancestor
  just grows to fit that run instead of ever handing `break-words` a
  constrained box to break inside. `ui-page-header`'s `<h1>`/`<p>`
  overflowed a passenger's own email this way (spec 21 slice 3); fixed
  with `min-w-0` on both of its flex wrappers, not by touching the text
  utility that was already correct.
- **A scroll container (`overflow-x-auto`) needs `position: relative`
  to actually contain an absolutely-positioned descendant.** `overflow`
  clips normal-flow content fine on its own, but an `absolute` child's
  *position* is computed against its nearest **positioned** ancestor —
  with none, that's the document root, regardless of any `overflow`
  in between. `ui-table`'s wrapper correctly clipped its own too-wide
  `<table>` but let an `sr-only` `ui-countdown` span (`position:
  absolute` via Tailwind's utility) escape to the page's own coordinate
  space and inflate `document.documentElement.scrollWidth` — invisible
  until spec 21 slice 3's Senior Mode grew a row wide enough to trigger
  it for the first time. Fixed with `position: relative` on the
  wrapper.

- **Never put two `<router-outlet>`s behind an `@if`/`@else`** to vary a
  shell's layout per route. Swapping outlets mid-navigation re-activates
  the route into a destroyed context: the router throws `Cannot read
  properties of undefined (reading 'data')` and the app renders blank.
  Keep one outlet and vary a wrapper's `[class]` (`marketplace-app`'s
  `AppShell`, spec 24).
- **Don't read the live `ActivatedRoute` tree (`route.firstChild…`) in a
  shell's constructor or a `toSignal` `initialValue`.** The child routes
  aren't wired yet and the router throws the same `reading 'data'` error.
  Walk `router.routerState.snapshot.root` instead.
- **A `<fieldset>` defaults to `min-width: min-content`**, so `truncate`
  on anything inside it silently does nothing and long text overflows
  its column. Add `min-w-0` to the fieldset (`search-results` filter
  sidebar, spec 24).
- **A card beside a sidebar should size by container, not viewport.** A
  `md:` three-column card collided at 1280px because the sidebar left it
  ~520px; `@container` on the card + `@2xl:` variants fixed it.
- **axe checks the contrast of `aria-hidden` text too.** Decorative
  large numerals in `ink-200` failed `color-contrast` even though hidden
  from assistive tech — use a real, readable label or draw it as SVG.
- **`text-muted` on `primary-subtle` is 4.3:1 — below AA.** An active
  tab/pill tinted `primary-subtle` needs `text-default` for secondary
  text.

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
- **`await fixture.whenStable()` can hang indefinitely once a real,
  recurring `setInterval` is running** — `CountdownClock`
  (`@shared-data`, spec 21 slice 2) starts one the instant a mounted
  `ui-countdown` has a non-null `secondsRemaining`, and Zone.js's
  stability tracking does not resolve while a periodic macrotask stays
  scheduled. A `my-bookings` test that reset a spy, called a method
  triggering an async refetch, then `await`ed `fixture.whenStable()`
  timed out at 5000ms even though the refetch itself completed in a
  microtask — every *other* test in the same file used the same
  pattern successfully, only because none of them awaited it a second
  time after the component had already settled once. Fixed the same
  way `cancel`'s own refetch test already had it right:
  `await new Promise((resolve) => setTimeout(resolve, 0))`, never
  `whenStable()`, for any assertion made after a component with a live
  timer (`ui-countdown`, `Poller`) is mounted.
- **A Playwright `fullPage` screenshot of a tall page misplaces a
  `position: fixed` element mid-image instead of at its true (bottom)
  position.** Seen on nearly every `*-390-senior.png` capture in spec 21
  slice 3's visual pass — Senior Mode's ~1.75x type scale is what makes
  an ordinary screen tall enough to cross whatever height triggers
  Chromium's multi-segment stitching. A direct, non-`fullPage` viewport
  screenshot of the identical state confirms the live app renders it
  correctly, pinned to the bottom, exactly as `e2e/responsive-nav.ts`
  already asserts in a real (unstitched) viewport. Capture-tool
  limitation, not a product defect — don't chase it as one.

## Known gaps, deliberate and open

- **`validator-app`'s nav is one link from wrapping** — measure before
  adding one, and note `w-full` resolves against the nearest flex
  parent, not the header (it measured 193px, not 358, for two slices).
  `customer-app`'s equivalent header row is **fixed** as of spec 21
  slice 1: below 640px the nav moved to a fixed bottom tab bar instead
  of growing the top row further. `validator-app` is explicitly out of
  scope for that spec (desktop-first, no Senior Mode) and still carries
  the older top-row pattern — keep its labels short rather than
  pre-empting a fix nobody has scoped yet.
- **A picker that fetches one bounded page cannot reach every row.**
  `booking-list`'s trip dropdown was the recorded case and is **gone**
  (spec 14 slice 3b replaced it with server-side search, and its e2e
  test is green); `SelectedBusinessStore` pages in a loop. Still
  one-shot at `limit=100`: `BusinessOptionsService`. **`trip-search`'s
  own Route picker is fixed too** (fix batch, 2026-09-12):
  `RouteBrowseView` gained the same `?search=` `_apply_list_query`
  already used by the staff Route list, and `trip-search.ts` gained a
  debounced search box above the `<select>` — narrowing the request
  server-side reaches a route regardless of total count, rather than
  hoping default order keeps it inside the first 100. `booking.spec.ts`
  and `open-seating.spec.ts`'s fixture-route helpers both use it now.
  `BusinessOptionsService` remains the one open instance of this class.
- **`marketplace-app` storefront gaps (spec 24's survey).** Every
  surveyed aggregator (Omio, Busbud, FlixBus, Rome2Rio, BuuPass, Wakanow)
  shows popular routes; Busbud and BuuPass show an operator wall. Neither
  is built, because nothing backs them honestly: `/marketplace/stops/
  suggest/` returns stops alphabetically (no popularity), and there is no
  marketplace operator-list endpoint or operator logo. Each needs backend
  work first — see spec 24's baseline table (⛔ rows). **Seats-left (⛔ in
  that same table) is no longer one of these** — `docs/specs/
  22-marketplace.md` slice 3 (2026-09-19) added a real
  `capacity_remaining` to the search response, independently of spec 24;
  update spec 24's own baseline table row to ✅ when that spec is next
  touched, rather than trusting this note or that table over the actual
  `TripSearchResultSerializer` field.
- **`NotificationBell` has no dark-header variant.** `marketplace-app`'s
  navy `AppShell` recolours its trigger with a descendant selector
  (`[&_app-notification-bell>div>button]`). A second dark header should
  add a `tone` input to the component instead.
- **Django admin cannot read RLS-protected models** — an admin request
  authenticates by cookie, resolves as anonymous, and sees zero rows.
- **Production reverse-proxy topology for white-labeled custom domains**
  is documented but unbuilt, as is AWS provisioning and S3 media
  storage.
- **Botswana has no PSP** — Paystack does not operate there (ADR-0007).
- **Naming, settled and not to be "fixed":** the *credential* is Tap &
  Go; the *fare model* is Pay as you go; the `/tap-go` route path stays.
- **`prune_e2e_test_data` couldn't clear the KYB review queue — narrowed,
  not eliminated** (F8, fixed 2026-09-12). Root cause: any stray
  Business that went through the KYB submission flow carried a
  `KybDocument` (`on_delete=PROTECT`), so the command's own
  `business.delete()` raised `ProtectedError` and silently skipped
  nearly every one it found (123 of 128 on this dev database). Fixed by
  deleting a stray Business's own `KybDocument`/`Director` rows first —
  a dev/CI-only fixture document carries no audit value, unlike the
  same model in production. One real run: 121 of 128 Businesses cleared
  (up from effectively none). **Route pruning is deliberately left
  alone**: a Route's own `ProtectedError`s come from real
  `Schedule`/`Trip`/`FareRule`/`Incident` rows, which are usage data
  even in a test fixture, and force-cascading through them risks
  breaking other specs' assumptions about ledger/booking state. So
  Route-side cruft (839 protected rows on this database) still
  accumulates unboundedly — this is why `trip-search`'s own picker
  needed the `?search=` fix above rather than relying on pruning to
  keep it inside `limit=100` forever.
- **`ui-map`'s marker popup ("Simulated data") fails colour contrast —
  fixed 2026-09-12.** Measured 2.71:1 against the 4.5:1 floor; the
  markup itself carried no explicit colour (Leaflet's own popup default
  measures ~12.6:1, so the exact source of 2.71:1 in a live browser was
  never pinned down precisely). Fixed by not relying on inherited
  styling at all: the "Simulated data" text is now explicitly styled
  with `--color-warning` on `--color-warning-surface` (5.02:1, the same
  pairing `ui-alert`'s `warning` variant uses), which is correct
  regardless of whatever the untouched markup was actually resolving
  to.
- **`ui-table` didn't adapt to Senior Mode's larger type — fixed
  2026-09-12, scoped to `customer-app`.** A narrow primary column could
  wrap mid-word (`credentials`' "Type": "QR code" → "QR"/"cod"/"e" at
  390px), because the base `overflow-wrap: anywhere` rule (needed to
  stop one unbroken token forcing a column wider than the viewport)
  applied indiscriminately. Fixed with a `[data-senior='true']`-scoped
  override to `overflow-wrap: normal` on non-action cells — still wraps
  at a space, just stops manufacturing a break where a word boundary
  was already available. Inert everywhere `data-senior` isn't set, so
  the three operator apps' three-times-hardened console density is
  untouched. The table's own `overflow-x-auto` scroll remains the
  fallback for a genuinely wide row (`my-bookings`' Pay button) —
  unchanged, and never claimed to need more than that.
- **A staff-gated endpoint 403s a passenger token regardless of
  fixture state, and the error looks like "no matching row" if nothing
  checks the response status first.** `findTripCarryingPassengers`
  reads `GET /bookings/` (`booking.view`, staff-only per its own
  `get_permissions`) — `trip-tracking.spec.ts` called it with the
  *passenger's* token, which always 403s there, and the fixture-lookup
  helper only reads `page.results` with no status check, so the
  failure surfaced three calls away as `Cannot read properties of
  undefined (reading 'find')`, not as an auth error. Found running the
  actual Playwright suite (apparently for the first time — this file
  was written and, per spec 20 slice 4's own note, only manually
  verified in a browser, never executed) while confirming spec 21
  slice 1's `AppShell` rewrite didn't regress `trip-tracking`. Fixed by
  passing the staff token instead — the trip located is the
  passenger's own, but the *lookup* is a staff-only read.
- **`NavShell` kept an icon rail at 390px — fixed 2026-09-12** (self-
  check 2026-08-26's F9). Below a new `DRAWER_BREAKPOINT` (639px,
  strictly narrower than the existing 768px icon-rail breakpoint so the
  two never overlap), the sidebar now goes fully off-canvas instead of
  shrinking to a 64px rail, toggled by a hamburger button in a slim top
  bar that only exists at that width. `effectiveCollapsed` treats an
  open drawer as "temporarily not collapsed," so every existing
  icon-rail-vs-expanded template branch (labels, width, ARIA) does the
  right thing without a second set of them. The closed drawer is
  `[inert]`, not just visually off-canvas, so its nav links/profile
  button/notification bell can't sit in the keyboard tab order while
  invisible — the same class of bug fixed in `ui-map`'s markers during
  spec 21 slice 1. Reclaiming the rail's width measurably helped
  `ui-table`'s own 390px fit on console screens (confirmed live: a row
  action button that needed horizontal scroll behind the rail no longer
  does).
- **The KYB queue had no search — fixed 2026-09-12** (self-check
  2026-08-26's F7). `KybQueueListView` now takes the same `?search=`
  pattern `BusinessListCreateView` already established (name,
  case-insensitive substring), with a `ui-filter-bar` wired to it.
- **The four Playwright projects' one documented interference —
  resolved 2026-09-12, but not the way F6c assumed.** `kyc-queue.spec.ts`
  and `kyb-queue.spec.ts` (both `super-admin-app`) share no fixture row
  and never did; the "reproducibly flaky... a parallel-execution
  artifact this session couldn't further isolate" comment on their
  Escape-focus-restoration assertion was checking the wrong cause. The
  real bug, found by actually testing the assertion in isolation until
  it failed there too: both queue screens' post-close refetch ran
  unconditionally, including on cancel/Escape, tearing down and
  rebuilding the whole table (and the button CDK's Dialog had *just*
  synchronously restored focus to) a moment after a cancelled review —
  which changed nothing and never needed a refetch at all. Fixed by
  only refetching on an actual decision. No `playwright.config.ts`
  change was needed or made; `workers: 1` was tried and confirmed **not**
  to fix the original assertion (it still failed in isolation), which is
  what led to finding the real cause instead.
- **Three new, unrelated defects surfaced running the full suite while
  verifying the fix batch above (2026-09-12) — none fixed, none caused
  by that batch** (confirmed: none of the files involved appear in its
  diff):
  - `client-admin-app/routes.spec.ts`'s "deactivates a route"/"leaves
    the route untouched when cancelled" tests fail deterministically,
    isolated, every run: the row's "Actions for …" button correctly
    reports `aria-expanded="true"` after being clicked, but no
    `menuitem`s ever appear in the accessibility tree — the dropdown
    menu itself never renders. Not a fixture/data issue (the route is
    freshly created with a unique name and confirmed "Active" first).
    `route-list.ts`/`action-menu.ts` are untouched by any spec in this
    arc's recent sessions; this looks like a real, previously
    undiscovered `ActionMenu` (or its overlay) defect, not something
    tied to a specific row's data.
  - `client-admin-app/live-operations.spec.ts`'s own axe check fails on
    `aria-allowed-role`: a `<button role="listitem">` in what is
    presumably the trip-picker sidebar list. Unrelated to `ui-map` (the
    flagged node has no map markup at all) and to anything touched in
    the specs 19–21 arc.
  - `open-seating.spec.ts`/`validate-ticket.spec.ts`'s shared "Yaba →
    Lekki" fixture trip: on this dev database, the trip for "today" was
    found `in_progress` (and duplicate Trip rows exist for several
    dates, including one *future* date already `in_progress`, which no
    real departure-time transition explains). `GET /trips/search/`
    forces `status=SCHEDULED`, so a passenger-facing search finds
    nothing. Confirmed unrelated to the `trip-search` fix above (that
    fix's own job — reaching the *route* regardless of count — is
    verified working; this is the *trip*, a level down, drifting for
    reasons this session didn't trace further). Likely accumulated
    corruption from repeated non-idempotent test/status mutations
    against this one long-lived dev database across many past sessions,
    not a code defect — `seed_e2e_users` only ever creates a missing
    Trip, never resets an existing one's `status`.
