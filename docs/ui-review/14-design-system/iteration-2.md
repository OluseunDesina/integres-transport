# Spec 14 Slice 2 — visual review

Captured 2026-08-31 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=<app> --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-2/`** — the ten primitives as first built.
- **`iteration-3/`** — after the three fixes below, plus
  `vehicles-compact-1200.png`, captured separately because the harness
  always renders the default density and the whole question was whether
  the density control does anything.

Slice 1's own `baseline/` remains the pre-design-system reference.

## Capture-list fix carried over from iteration-1

Iteration-1's **F3** recorded that the `client-admin-app` captures landed
on whichever Business `SelectedBusinessStore` auto-selects, and that this
one has no data — so every list photographed as an empty state and no
populated row was ever in the capture set. The harness now takes an
`activeBusinessName` and sets the store's own localStorage key before
capturing.

**The first version of that fix reproduced this repo's most-repeated
bug.** It resolved the Business from a single `limit=100` fetch. This dev
database holds 144 Businesses of accumulated e2e cruft ordered
`-created_at`, and the fixture Business — created long before all of it —
sits past the first hundred. The lookup found nothing, returned quietly,
and the capture ran against the empty Business again, producing a set of
screenshots that looked plausible and showed the wrong thing. It now
pages, and **throws** rather than falling back: a capture that silently
photographs a different screen is worse than one that fails.

This is the same "bounded fetch, `.find()` by id, silent fallback" family
as `SelectedBusinessStore`, `paystack-config`, `settlement-runs` and the
seven screens `ListStore.findByIdPaged` was built for. It found a new
home in test tooling, which has no store to inherit the fix from.

## Findings

### F1 — Fixed: the action menu set the row height for the whole console

`iteration-2/client-admin-app/vehicles-1200.png`. Every row renders one
`ui-action-menu`, and its trigger carried this library's usual
`min-h-11`. A fixed 44px floor plus cell padding made rows ~68px against
the ~40px they were when the row ended in a plain "Edit" link — roughly
halving what fits on screen in a data-dense console.

Fixed by sizing the trigger from `--ui-control-height` instead: 36px on
the `console` profile, 44px on `consumer`. 36px clears WCAG 2.2
SC 2.5.8's 24px minimum with room to spare on a pointer-driven
back-office table, and 44px is preserved everywhere a finger is the
input.

This is **the first thing in the workspace that reads a surface-profile
token.** Slice 1 shipped `--ui-control-height`, `--ui-row-height`,
`--ui-gutter`, `--ui-section-gap`, `--ui-text-body` and
`--ui-text-heading`, and set `data-surface` on all four apps' `<html>` —
and nothing consumed any of them, so the two profiles were inert. The
new primitives now read them.

### F2 — Fixed: compact density barely differed from comfortable

Follow-on from F1, and the more interesting half. With the trigger at
36px, cell padding alone moved rows from 60px to 48px — a control whose
two states look nearly identical, which reads as broken.

Fixed by making compact a **scoped override of the surface profile**
rather than tighter padding: the table container sets
`--ui-control-height: 1.75rem`, and every token-sized control inside
shrinks with it. Compact is now ~38px against comfortable's ~61px —
`vehicles-compact-1200.png` fits the same 25 rows in 1230px that
comfortable needs 1800px for. 28px still clears the 24px minimum.

That the fix is three declarations rather than a per-component compact
variant is the token layer doing its job.

### F3 — Fixed: the filter bar's search box spanned the page

`iteration-2/super-admin-app/businesses-1200.png`. `flex-1` with no cap
made the search a ~900px input on a 1200px console, reading as the
page's main field rather than as a filter for the table beneath it.
Capped at `max-w-sm`, which also matches the width the screen used
before `ui-filter-bar` replaced its hand-rolled form.

### F4 — Recorded, not fixed: the density toggle floats alone

`iteration-3/client-admin-app/vehicles-1200.png`. It sits right-aligned
in its own band of whitespace with nothing beside it. It belongs in a
list toolbar alongside filters and result counts — which is **slice 3's**
`client-admin-app` list rebuild. Inventing that row for one screen now
would pre-empt a layout decision that should be made once, for all
thirty-five.

### F5 — Recorded, not fixed: client-admin tables overflow at 390px

`iteration-3/client-admin-app/vehicles-390.png`. The Status and Actions
columns fall outside the viewport; the table scrolls horizontally (with
`ui-table`'s scroll shadow) but a row's actions are unreachable without
scrolling sideways.

**Identical in the baseline** — the old "Edit" link sat in the same last
column and was equally off-screen — so this is not introduced here. A
data table is the wrong shape for a 390px screen, and the fix is the
list rebuild in slice 3, not the token layer. Related to, but distinct
from, the customer-app overflow spec 21 owns.

## Not findings

- **`ng build shared-ui` fails** with `Cannot destructure property 'pos'
  of 'file.referencedFiles[index]'`. Verified against HEAD with the
  slice stashed: **it already failed.** Nothing runs it — the workspace
  consumes libraries through tsconfig path mappings, and `build:all`
  builds only the four apps.

## Verification alongside the visual pass

- 211 `shared-ui` unit tests (up from 101 at the end of slice 1), 916
  across the workspace, four clean builds, lint clean on all nine
  projects.
- Axe clean on every capture, including the new drawer and the confirm
  dialog, asserted inside `vehicles.spec.ts`.
- E2E per project. `client-admin-app` 72 passed; `validator-app` 7/7;
  `super-admin-app` and `customer-app` pass except for fixture-state
  failures that reproduce identically on HEAD (see the slice's
  implementation note).
