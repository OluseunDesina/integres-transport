# Spec 15 slice 2 — visual review

Captured 2026-09-03 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

- **`iteration-1/`** — `client-admin-app` as first built.
- **`iteration-2/`** — after F1 and F2.

The capture harness gained a `UI_REVIEW_SPEC` env var so a later spec's
pass files under its own heading instead of accumulating inside spec
14's. It defaults to `14-design-system`, so every existing command is
unchanged:

```bash
UI_REVIEW_SPEC=15-trip-classes UI_REVIEW_DIR=iteration-1 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

`client-admin-app`'s capture list gained three `flows` entries. The fare
grid needs a route id in its URL *and* a per-segment Business — under
the flat-priced Business the rest of the capture uses it only ever
photographs its "this business prices fares flat" warning, so the class
selector and inherited cells would never have been seen at all.

## Findings

### F1 — Fixed: the inherited amount was drawn at 2.64:1

`iteration-1/client-admin-app/fare-matrix-premium-1200.png`. On a class
grid, a cell that inherits its price from the Any-class grid shows that
amount as the input's **placeholder** — the choice that makes it dim,
replaceable by typing, and absent from a save, all at once.

But nothing set a placeholder colour, so Tailwind's preflight drew it:
`currentColor` at 50%, which over this field measures **2.64:1**. WCAG
1.4.3 asks 4.5:1 for text, and this placeholder is not a hint — it is
the number a passenger will actually be charged. It would have been the
one thing on the grid a low-vision operator could not read.

Now `placeholder:text-muted` (**4.76:1**) plus `placeholder:italic`, so
the inherited/owned distinction does not rest on contrast alone either.
A unit test asserts both classes, since no screenshot will notice this
coming back.

### F2 — Fixed: two adjacent neutral pills read as one

`iteration-1/client-admin-app/trips-1200.png` put Class immediately
before Status. Both render as neutral `ui-status-pill`s — the class
deliberately so, since that component's other tones are semantic and a
Mini is not negative — and the two commonest values are **"Standard"**
and **"Scheduled"**. Two identical grey chips, adjacent, same first
letter: at a glance they read as a pair rather than as two different
facts, and telling them apart means going back up to the headers.

Class now sits beside Route. That also groups them correctly: Route and
Class say what the service *is*; service date, departure and status say
where it has got to.

## Confirmed working

- **The inherited mechanism reads correctly.** On the Premium grid,
  `24379.00` (set for Premium) is upright and full-contrast while
  `16248.00` and `8124.00` (inherited) are italic and muted, with the
  legend naming what greyed means and each cell's accessible name
  carrying the same sentence.
- **Nothing is dirty on arrival.** "No unsaved changes" with three
  populated-looking cells is exactly the state that would be wrong if
  inherited amounts had been seeded into the draft.
- **`route-form`'s empty allow-list explains itself** — "None selected,
  so this route accepts every class", which disappears the moment a
  class is ticked. An all-unchecked group otherwise reads as "nothing
  allowed", the opposite of the truth and the state every route that
  predates this spec is in.
- **The narrowing works end to end.** `schedule-form` opened on a route
  offering only Premium shows Premium selected — the reconciliation
  effect (below) moving the value into range, live.
- **390px holds.** The class re-flows into the trips sub-line
  ("2026-08-10 · 06:30 AM · Standard"), the fares list fits three
  columns, and the fare grid scrolls inside its own container as
  designed. `responsive-tables.ts` passes at all three widths.
- Axe clean on every capture and through the e2e suite.

## Two defects found by tests rather than screenshots

**Narrowing the options did not move the value into them.** A control
still holding `standard` while the route offers Premium alone renders a
`<select>` with no matching `<option>`: it looks empty, keeps its old
value, and 400s on submit with "this route does not offer standard
services" — the exact failure the narrowing exists to prevent, reached
from the other side. Found by `trip-classes.spec.ts`; the unit tests
were green against it. Fixed with a reconciliation `effect` on both
`schedule-form` and `trip-form`, plus two unit tests.

**The grid was editable while showing the wrong class's prices.**
Between the selector changing and the new grid arriving, the heading and
legend already named the new class while the table still held the
previous one's amounts — and every cell was live. An operator typing in
that window would have been editing prices they were never shown. The
grid now marks itself `aria-busy` and disables its cells until the data
matches the label.

## Verification alongside the visual pass

- **496 `client-admin-app` unit tests**, up from 461. 1223 across the
  workspace. Four clean builds, lint clean on all nine projects.
- **All four e2e projects green**, `client-admin-app` at 87 including
  the new `trip-classes.spec.ts`, run three times to confirm it is
  repeatable against a database that keeps everything previous runs
  wrote.
- **797 backend tests, unchanged** — the one backend edit was a
  serializer field declaration with no behaviour attached.
