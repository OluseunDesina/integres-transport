# Spec 16 slice 4 — visual review

Captured 2026-09-05 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=16-operational-analytics UI_REVIEW_DIR=iteration-5 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

`iteration-4` is this slice's before, `iteration-5` its after;
`iteration-1` through `3` were slice 3's. Three entries were added to the
capture list: `revenue`, `revenue-weekly`, and a **flow** for
`trip-performance`, which a URL cannot reach cold — it needs a real Trip
id, and the trip list is the only place one is on screen.

## Three defects found, all fixed

None of the three was visible to any assertion.

### F1 — an empty trip's doughnut read as a full one (`ui-chart`, fixed)

`iteration-4`, `trip-performance`. The occupancy ring is "Sold" against
"Empty", and `ui-chart` coloured slices from its palette **by
position** — so "Empty" got `--color-success`. A departure that had sold
nothing therefore rendered as a **solid green ring**, which at a glance
says *full*, and the only thing contradicting it was the legend text
beside it.

The palette-by-position rule is right for peer categories (payment
methods) and wrong for a part and its remainder. `ChartPoint` gained an
optional `color`, honoured by the doughnut, and the screen names its
own: sold is the brand colour, empty is `--color-surface-sunken` — the
same colour as the track behind the ring, so the ring now visibly fills
as the bus does.

### F2 — the channel counts looked like they contradicted the total (dashboard→revenue, fixed)

`iteration-4`, `revenue`. "Transactions 4" sat above a payment-method
breakdown reading "unknown 1 payment / wallet 4 payments". 1 + 4 = 5.

Both numbers are correct. A payment split between a card and a wallet
balance has its **amount** divided across two rows — those still sum to
the gross — but it is **counted once under each method it used**. The
screen said none of that, and a reader working it out for themselves is
exactly the quiet confusion this spec exists to prevent. A sentence
under the section heading now says it plainly.

### F3 — "1 payments" (fixed)

The re-flowed sub-line on all three breakdown tables hardcoded the
plural. One shared `paymentCount()` now.

## One regression caught by an existing guard, not by eye

Linking the trip list's route name to its performance screen made that
table need **16px of sideways scroll at 390px**, and
`e2e/responsive-tables.ts` failed on it.

The cause is a rule `ui-table` already documents: it resets
`overflow-wrap` to `normal` inside a `<button>` or `<a>`, so a control's
*label* is never split mid-word. But this link's text is the route name,
which is data — so the column's minimum width grew to its longest word.

Worth recording because the obvious fix did not work: a utility class on
the anchor loses to `ui-table`'s `::ng-deep` descendant selector on
specificity. It sits on a `<span>` **inside** the anchor instead, where
an explicit value simply beats the inherited one and no `!important` is
needed.

## Confirmed working

- **Axe is clean** on `revenue`, `payments` and `trip-performance` at
  every width, and across the whole 105-test `client-admin-app` project.
- **390px holds** on all three. The stat grids stack one-up, the filter
  controls stack, and every table drops its `Payments` column and
  re-flows the value into the amount cell's sub-line.
- **Every chart carries its accessible data table** — asserted in the
  component specs, the screen specs and the e2e run.
- **The nulls read as nulls.** "Not available" rather than `0%` with no
  vehicle; "Not departed yet" rather than "0 minutes late"; an empty
  state for a trip with no payments rather than a row of zeros.
- **The payments list is no longer truncated to 30 days.** Visible in
  `payments-1200`: 15 payments listed with no period set, where before
  this slice the same screen would have shown only those from the last
  month, silently.
- **Money reads per currency**, one stat block and one trend chart each,
  never a shared value axis.

## Not fixed

- **The "Empty" legend swatch is nearly invisible**, being the same
  colour as the surface it sits on. Deliberate: it matches the ring, and
  the label and value beside it carry the meaning. Colour is not the
  only signal anywhere here.
- **`ACTIVE ROUTES 999`** and the accumulated e2e cruft behind it,
  unchanged from slice 3 and not this slice's to fix.
