# Spec 16 slice 3 — visual review

Captured 2026-09-05 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=16-operational-analytics UI_REVIEW_DIR=iteration-3 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

Three iterations, all `client-admin-app`. `iteration-3` is the final
state; `iteration-1` and `iteration-2` are kept because two of this
slice's four defects were **only** visible as pictures and are worth
being able to point at.

The capture list changed in two ways. `home` was renamed `dashboard`,
because spec 16 slice 3 replaced that route's static link list with a
different screen rather than restyling it — pairing the two against
spec 14's baseline would compare unrelated pages. And a second entry,
`dashboard-weekly`, captures the same screen at
`?date_from=2026-06-01&date_to=2026-09-05&granularity=week`: the flat
list photographs the dashboard with **no filters set**, so the chip
strip, the weekly bucket axis and a long-range trend — the shapes this
screen is actually used in — were not in the capture set at all.

## Four defects found, all fixed

Three of the four were invisible to every test that passed.

### F1 — a lone data point rendered as a smear (`ui-chart`, fixed)

`iteration-1`, both revenue charts. A day with revenue either side of a
gap has no line to draw, so the component marks it with a dot. That dot
was an SVG `<circle r="2">` — and the plot is stretched non-uniformly
(`preserveAspectRatio="none"`), which distorts *geometry*.
`vector-effect="non-scaling-stroke"` exempts stroke width from that
scaling but not a circle's radius, so each marker came out as a wide,
flat ellipse: at 1200px, roughly 20px × 6px.

Fixed by drawing the marker as a **zero-length line with a round cap**
instead. A cap is stroke, so `non-scaling-stroke` applies and the mark
is a true circle in screen units at any container aspect ratio. The
component spec now asserts the element, its linecap, its vector-effect,
and that `x1 === x2` — and that no `<circle>` is used for it.

### F2 — the filter row sat on two baselines (dashboard, fixed)

`iteration-1`, 1200px only. `ui-filter-bar` aligns its content
`items-end`, and "Group by" carries a hint below its select, so
bottom-alignment lifted that control a full line above the two date
fields. Three controls, two label baselines: it read as a broken layout
rather than as a set.

Fixed by top-aligning the three inside their own wrapper. Invisible at
390 and 768, where they stack.

### F3 — the maximum was clipped, and its label sat on top of it (`ui-chart`, fixed)

`iteration-2`, clearest on `dashboard-weekly`. The value axis mapped the
maximum to `y = 0`, the very top edge of the viewBox, so anything with
width was cut in half there — the tallest bar's cap, and the lone-point
marker from F1, which lost its top half. Separately, the axis-maximum
label was absolutely positioned over the top-right of the plot, i.e.
directly on the highest bar and the topmost point: it overlapped exactly
the value it was naming.

Fixed together: the plot now reserves 6 units of headroom above the
maximum, the five gridlines are placed at even fractions of the **value**
range (so the top line *is* the maximum, rather than an arbitrary
ceiling above it), and the label moved out of the plot to a row of its
own above it.

### F4 — no visible defect, but the pictures explained one

`iteration-1`'s revenue chart showed two isolated points across a 30-day
axis with nothing between them. That is correct — the endpoint emits
only buckets that have data and the client draws gaps rather than zeros
— and seeing it drawn is the clearest confirmation that
`toTrendPoints`' expansion lines up with the server's own bucketing.
Recorded as confirmation, not a defect.

## Confirmed working

- **Every chart carries an accessible data table.** Asserted in
  `chart.spec.ts`, in `dashboard.spec.ts` and again in the e2e run; the
  `<svg>` is `aria-hidden` and the table is `sr-only` with a real
  `<caption>`. Charts are the one control on this screen that a
  screen-reader user cannot read at all otherwise.
- **Axe is clean on the dashboard at every width**, and across the whole
  91-test `client-admin-app` project.
- **390px holds.** The stat grid stacks one-up, the filters stack, and
  the recent-transactions table drops its `Channel` column and re-flows
  the value into the amount cell's sub-line, per `ui-table`'s
  convention. No horizontal overflow.
- **Money reads per currency.** The section heading is
  `Revenue · NGN`, and a second currency gets its own heading, its own
  stat block and its own chart — never a shared value axis, which would
  be the visual form of the addition the API shape exists to prevent.
- **The three states are distinguishable on sight.** Skeletons while
  loading, a `ui-alert` naming the problem on a rejected range, and an
  empty-state heading that still prints the period underneath it. That
  last one is what the `period` echo is in the envelope for.

## Not fixed

- **`ACTIVE ROUTES 999`** in every capture. Real, and not this slice's:
  it is accumulated e2e cruft on the shared dev database, the same
  backlog `prune_e2e_test_data` exists for and cannot fully clear.
- **The revenue chart is mostly empty space** on a 30-day range with
  four payments in it. Honest rather than wrong; a chart that filled the
  gaps would be inventing the days it drew.
