# Visual iteration 1 — Phase 3 (Network, Scheduling, Fleet)

One iteration, exited on criteria met (not the 5-iteration cap). 96
screenshots (32 states × 390/768/1440px, 1440 authoritative) across all 7
screens Phase 3 added (Routes, Stops, Vehicle Types, Vehicles, Drivers,
Schedules, Trips), all opened and reviewed. Review delegated to 3
parallel agents (Routes+Stops; Vehicle Types+Vehicles+Drivers;
Schedules+Trips) to protect this session's own context window — same
approach Phase 2's self-check used — then every finding independently
re-verified live (`boundingBox()`, `scrollWidth`/`clientWidth`
measurements, direct DOM inspection) before acting, per the
verify-before-fix discipline Phase 2's own report established.

## Findings and outcomes

1. **[Fixed, real — the one blocker] Trips' 8-column table hid the
   Compliance and "Change status" columns entirely at every viewport,
   including 1440px (authoritative).** Live-measured: no page-level
   horizontal scroll existed (`document.body.scrollWidth ===
   documentElement.clientWidth`), but the table's own `overflow-x-auto`
   wrapper genuinely overflowed (1366px content in a 1134px box) with the
   action button reachable only via undiscovered horizontal scroll.
   Fixed two ways: (a) constrained the Vehicle/Driver `<select>` cells to
   `max-w-40` so the table needs less width overall, (b) made the
   Actions column `sticky right-0` with a `bg-white` + subtle
   left-edge shadow, so "Change status" is always within the viewport
   and clickable regardless of scroll position — verified live via
   `boundingBox()` at all three viewports, and via an end-to-end click
   that opens the dialog with zero manual scrolling.
2. **[Fixed, real, root-caused at the shared component] The
   `overflow-x-auto` horizontal-scroll mechanism on every `ui-table` in
   the app has worked correctly since Phase 2 (verified live wherever a
   table exceeds its box: Routes/Vehicles/Drivers all confirmed
   scrollable via `scrollWidth`/`clientWidth`), but carried zero visible
   hint that a table scrolls.** Phase 2's self-check found this on the
   KYC/KYB queues and deliberately deferred it as minor/polish; this
   round it recurred a third time (Vehicle Types/Vehicles/Drivers/
   Schedules at 390px). Fixed at the root in `ui-table` (`table.ts`) with
   a CSS-only left/right scroll-shadow (`background-attachment: local`
   vs `scroll` layering, no JS) — every table in the app gets the
   affordance now, not just Trips.
3. **[False positive, caught by live verification] "Stop-reorder ↑/↓
   controls and the Remove link are under the 44×44px minimum tap
   target."** Measured live: `min-h-11 min-w-11` (44×44px) is already
   correctly applied — the reviewing agent was reading the small visible
   glyph size from a static screenshot, not the actual (larger, padded)
   clickable box, which a screenshot can't show. No fix — the code was
   already correct. Named explicitly here, matching Phase 2's own
   Finding #7 precedent for methodology transparency.
4. **[Fixed, real, minor tap-target gap] Schedule's Mon–Sun day-checkbox
   labels measured 50×20px** — width was fine, height was under the
   44px minimum (confirmed live, not from the screenshot alone: the
   native label-wraps-input click behavior already worked, just within
   too small a hit-box). Fixed with `min-h-11` on the label in
   `schedule-form.html`, matching the exact class Phase 2's own NavShell
   tap-target fix used.
5. **[Fixed, real consistency defect] `Route`/`Stop`/`VehicleType`/
   `Vehicle`/`Driver` list screens rendered their Status column as plain
   text ("Active"/"Inactive") while the adjacent Compliance column (on
   Vehicles/Drivers) and Schedule's own Status column correctly used
   `ui-status-pill`.** Confirmed via direct template inspection, not
   just visual impression. Fixed: all 5 list screens now use
   `ui-status-pill` (`tone="positive"`/`"neutral"`) for Status,
   consistent with Schedule and with the Compliance column's own
   pattern.
6. **[Fixed, real, cosmetic] Trip's status pill showed the raw
   `in_progress` (snake_case) value** while every sibling pill/label in
   the app shows humanized text ("Scheduled", "Completed", etc.). Fixed
   with a `STATUS_LABEL` map in `trip-list.ts`.
7. **[Not a defect — same already-diagnosed environment issue] The
   Business column showed a raw UUID on one Drivers screenshot.** Root
   cause: `businessNames()`'s lookup Map only contains the first-fetched
   page of Businesses, and this e2e Client now has 114+ accumulated
   Businesses from repeated test runs across this session — the exact
   same root cause already diagnosed for `profile-menu.spec.ts`'s
   Business-switcher list. Not a new Phase 3 bug; not fixed, matching
   the standing decision not to bump limits or reset the dev database
   without being asked.
8. **[Not fixed — judged acceptable, cosmetic, pre-existing pattern]
   Long input text (e.g. a stress-test route name) overflows
   `ui-text-field` with no truncation ellipsis, just native `<input>`
   clipping.** Shared by every `ui-text-field` consumer app-wide, not
   specific to Phase 3; doesn't break layout at any viewport.
9. **[Not fixed — judged acceptable, cosmetic] Date/time formatting is
   inconsistent across the module**: Schedule shows raw `07:30:00` /
   ISO `2026-01-01`; Trip shows locale-formatted `9/15/26, 8:00 AM` via
   Angular's `DatePipe`. Low-severity polish item, not addressed this
   round.
10. **[Process finding] One visual-review agent's severity call
    ("blocker") on the Trips table was directionally correct — the
    content genuinely was unreachable by default — but its root-cause
    read (implying a page-level layout bug) was inaccurate; the actual
    mechanism was a correctly-functioning internal scroll with no
    affordance, one class more forgiving than "broken," but with the
    same practical impact for a real user.** Live measurement was what
    turned a fuzzy "blocker" into a precise, fixable diagnosis — same
    "measure before you fix" lesson Phase 2's report already named,
    reconfirmed here.

## Exit criteria

- Zero AXE violations at WCAG AA on every screen — verified via all 7
  e2e spec files' inline `AxeBuilder` assertions (35 assertions total
  after closing the 3-state gap in `trips.spec.ts`), all passing after
  every fix above.
- Zero browser console errors/warnings introduced by this phase —
  confirmed via a live console listener across all 7 screens; the only
  messages present are pre-existing, already-documented ones (the
  local-dev `white-label/resolve/` 404 from Phase 1, and Angular's
  `allowSignalWrites`-is-a-no-op deprecation notice present on every
  `effect()` call using that option app-wide since Phase 2).
- No clipping, overflow, collision, or broken alignment at any captured
  viewport — the one real instance (Trips) fixed; the recurring
  scroll-affordance class fixed at the root; the false-positive tap-
  target claim resolved by measurement, not a code change.
- Every state renders correctly, including stressed content (a
  deliberately very long route name, expired compliance dates, an empty
  vs. two-stop route, 25+ accumulated list rows).
- Every interactive element has a visible focus state; mobile targets
  are ≥44×44px — the one real gap (Schedule's day checkboxes) fixed.
- Unit tests, affected e2e specs, lint, and type-check all pass — full
  `test:all` (8/8 project suites, 326 total specs), `build:all` (3/3
  apps), and the full combined Playwright run (client-admin-app +
  super-admin-app + customer-app) all green except the 2 already-known,
  pre-existing, unrelated `profile-menu.spec.ts` failures.
- The final iteration introduced no regression — confirmed via the full
  regression sweep re-run after every fix.

**Exit: criteria met**, not the 5-iteration cap. Final screenshots
promoted to `docs/ui-review/3-network-scheduling-fleet/baseline/`.
