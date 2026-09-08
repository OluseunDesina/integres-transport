# Spec 17 slice 2 — visual review

Captured 2026-09-06 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=17-incidents UI_REVIEW_DIR=iteration-1 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

`iteration-1` is this slice's before, `iteration-2` its after. Three
entries were added to the capture list: `incidents`, `incident-form`,
and a **flow** for `incident-detail`, which a URL cannot reach cold — it
needs a real incident id, and the queue is the only place one is on
screen. The seeded `INC-E2E001` fixture exists so that walk has
something to click.

## Four defects found, all fixed

Two were in this slice's own screens. One was in a shared component and
had already shipped in three other forms. One was in the review harness
itself.

### F1 — a select showed one value and submitted another (`ui-select`, fixed)

`iteration-1`, `incident-form`. The Severity control rendered **"Low"**
while the form control held `medium`. An operator who touched nothing
would have filed a Medium incident having read the word Low.

`ui-select` binds `[value]` on its `<select>`. That property binding is
applied **before** the `@for` block has created any `<option>`, so the
browser has nothing to match and falls back to the first one — and
because the bound signal never changed, Angular never writes it again.
The control and the screen disagree permanently.

Fixed by also binding `[selected]="option.value === value()"` on the
option, with two `shared-ui` regression tests: one for the initial
value, one proving a later `setValue` still reflects.

**This had already shipped.** It only reproduces when the initial value
is not the first option, which is why it survived thirty-odd usages —
filters default to their blank first entry, and edit forms patch after
the options exist. But `TRIP_CLASS_OPTIONS` begins with `premium` while
`vehicle-type-form`, `schedule-form` and `trip-form` all default their
control to `standard`: **all three displayed "Premium" and submitted
`standard`.** The same one-line fix covers them.

### F2 — "Assigned to" appeared twice, meaning two different things (fixed)

`iteration-1`, `incident-detail`. The context panel carried a read-only
**Assigned to — Nobody yet**, and about a screen further down a control
also labelled **Assigned to**, reading *Unassigned*. Two
identically-labelled fields with different wording, one a statement and
one a control, is something an operator has to click to understand.

The control is now **Assign to**, and its panel is titled *Status and
assignment* rather than *Move this on* — assignment is not a status
move, and the old title made the grouping a small lie. The read-only row
stays: an `incidents.view`-only reader never sees the panel at all, and
still needs to know who owns the incident.

### F3 — two fields both labelled "Note" (fixed)

`iteration-1`, `incident-detail`. One under the transition control, one
in the internal-note panel. Different panels, so less severe than F2 —
but still two identical labels on one screen, which is ambiguous to
anyone navigating by form field rather than by eye.

The evidence that it was genuinely ambiguous is that the e2e spec had to
disambiguate them **positionally**, with `.first()` and `.last()`. They
are now *Note on this change* and *Internal note*, and the spec targets
them by exact label.

### F4 — the harness photographed a whole pass of the wrong Business

Not a screen defect. The 1200 pass rendered every business-scoped list
as empty — including `trips-1200.png`, which spec 16's iteration-5 shows
holding 912 rows. Because the flows run last and the first of them
clicks a specific incident reference, the run then **hung** on a locator
that would never resolve, burning its entire timeout. That produced two
misleading symptoms: an apparently broken new screen, and an apparently
slow capture.

`e2e/session.ts`'s `selectBusinessByName` **silently returned** when its
Business lookup failed, leaving the harness on whichever Business was
auto-selected. It throws with the status code now — the same
"bounded fetch, silent fallback" failure its own docstring exists to
prevent, left unguarded in the one branch that mattered.

**Being precise about what this fixed:** the throw never fired on the
passing run, so the Business lookup was *not* returning an error. After
killing a long-lived dev server and every stray Playwright process, the
capture passed cleanly in **3.1 minutes** with all three widths correct.
The observed cause was therefore environmental — most likely a stale dev
server — and I could not reproduce it afterwards. The harness change is
a real correctness improvement and would have named the failure had it
been an HTTP one; it is **not** demonstrated to be the fix.

`ui-review-capture.ts`'s timeout was raised from 300s during the
investigation and has been set back down to **600s**. A clean run takes
~3 minutes; the headroom is for a growing capture list, deliberately not
larger, because a hanging walk burns the whole budget before reporting
and a 30-minute timeout only delays the news.

## Checked and clean

- Severity, status and category all render as `ui-status-pill` with a
  **text label**, never colour alone.
- Every nullable relation on the detail screen reads *Not recorded*, and
  the two time fields *Nobody yet* / *Not yet* — a blank cell would read
  as an empty value rather than an unknown one.
- The queue's open-only default renders as a removable chip at every
  width, so the narrowing is visible rather than silent.
- Column visibility parity holds across header, cell and skeleton at
  every tier, asserted by `expectColumnVisibilityParity` in both the
  loaded and loading states.
- Axe clean on every new screen and on every state the e2e spec walks
  through.
