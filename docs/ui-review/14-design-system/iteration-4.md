# Spec 14 Slice 3a — visual review

Captured 2026-08-31 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=client-admin-app --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-4/`** — the six rebuilt lists and the new shell top bar,
  as first built.
- **`iteration-5/`** — after the fix below.

The capture list gained `stops`, `vehicle-types`, `drivers` and
`schedules` this slice; it already carried `routes` and `vehicles`.

## Findings

### F1 — Fixed: the shell's quick-create control was an unlabelled "…"

`iteration-4/client-admin-app/routes-1200.png`, top right. The new top
bar rendered `ui-action-menu` in its default icon-only form — a bare
ellipsis, alone, in an otherwise empty bar. It carried
`aria-label="Create a new record"`, so a screen-reader user was told
exactly what it was and **a sighted user was told nothing at all.**

That is the inverse of the failure this codebase usually finds, and
worth recording as such: the accessible name was right, and the visible
affordance was missing. An ellipsis reads as "more actions on the thing
next to me", and there was nothing next to it.

Fixed with a `triggerLabel` input on `ui-action-menu`, so the shell
renders **"New ⌄"** while table rows stay icon-only — in a row the
column and the row's identity already supply the context. The accessible
name stays the fuller "Create a new record"; "New" alone would be a
worse announcement.

### F2 — Recorded, not fixed: the status filter's label sits above the row

Every list's filter bar puts a visible "Status" label over the select
while the search input's label is `sr-only`, so the two controls sit at
different heights. Deliberate for now — the search box's placeholder
already names what it matches ("Search by name, phone or licence…"), and
giving it a visible label would make the bar two rows tall on every
screen. Worth revisiting when slice 3b puts more controls in the same
bar.

### F3 — Recorded, not fixed: tables still overflow at 390px

`iteration-5/client-admin-app/schedules-390.png`. Status and Actions
fall outside the viewport; the table scrolls sideways, so a row's
actions need a horizontal scroll to reach.

**Identical in the baseline and unchanged by this slice** — the old
"Edit" link sat in the same last column. Already recorded as F5 in
`iteration-2.md`. A data table is the wrong shape for a phone, and the
answer is a card layout, which is a decision worth making once for all
thirteen lists rather than improvised per screen.

## Confirmed working

- **Sticky headers.** Measured live rather than asserted from a class
  list: the table region scrolled 400px (scrollHeight 1557, clientHeight
  558) and the `<th>` held at y=245 before and after.
- **Search reaches the backend.** `1–25 of 210` → `1–8 of 8` on
  `LAG-DRW`, and `0 of 0` with the inactive filter added. Verified at the
  API too: 210 unfiltered, 8 for `LAG-DRW`, 8 for `lag-drw`
  (case-insensitive), 3 for `is_active=false`, 0 combined.
- **Quick-create navigates**, and `ui-action-menu`'s deferred emission
  means focus is back on the trigger before the route changes.
- **Density is shared.** Choosing compact on one list holds on the next,
  because `TableDensityStore` is root-provided.

## Verification alongside the visual pass

- 717 backend tests (up from 690 before slice 3a), ruff and mypy clean,
  OpenAPI in sync.
- 400 `client-admin-app` unit tests (up from 349), 219 `shared-ui`, 44
  `layout`, 980 across the workspace. Four clean builds, lint clean on
  all nine projects.
- Axe clean on every capture and inside the e2e suites.
- E2E per project: `client-admin-app` 77 passed with only the two
  documented `bookings.spec.ts` known-reds; `validator-app` 7/7;
  `super-admin-app` 11/12 serially (the recorded cross-project
  `kyc-queue` fixture failure); `customer-app` unchanged from HEAD.

**One caution learned the hard way this slice:** both the dev server and
the Django `runserver` in this environment were serving pre-slice code,
and the first live search check reported "no narrowing" against a
backend that did not yet have the parameter. Restart both before
trusting a live check — the unit and API tests were right the whole time.
