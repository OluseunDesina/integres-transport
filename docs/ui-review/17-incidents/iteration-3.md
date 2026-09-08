# Spec 17 slice 3 — visual review

Captured 2026-09-06/07 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=17-incidents UI_REVIEW_DIR=iteration-3 E2E_SKIP_SEED=1 \
  npx playwright test --project=customer-app --project=validator-app --grep @ui-review
```

`iteration-3` is this slice's first pass; `iteration-6` is the settled
state. Four capture entries were added — `my-reports` and
`report-issue` in `customer-app`, a **flow** for the booking-entry
variant of the report form (a different screen: no operator picker, a
named trip instead, and it needs a real Booking id), and `report-issue`
in `validator-app`.

## Six defects found, all fixed

Two were layout regressions this slice caused. Two were wording
defects that made a screen ambiguous — one of them caught by
Playwright's own strict mode rather than by reading. Two were typography.

### F1 — the validator header grew to four rows at 390px (fixed)

`iteration-3`, `validator-app/report-issue-390`. The third nav link
pushed the header to **189px** on a 390px viewport — a fifth of the
screen, with "Record tap", "Validate ticket" and "Report a problem"
each on a row of their own.

The cause was not the third link. The nav carried `order-last w-full`,
which reads as "its own full-width row", but it sat **inside** a
`flex-1` wrapper shared with the brand mark, and the account controls
beside that wrapper are `shrink-0`. So `w-full` resolved against the
wrapper, not the header: measured at **193px**, not 358. Two links
never fitted that either; the third only made it visible.

Fixed by hoisting the nav to be a direct child of the header — exactly
`customer-app`'s own shape, and for the same reason — and by shortening
the new label to "Report fault" so all three fit one row. Measured
after: nav **358px**, all three links on one row, header **109px**,
*smaller than before this slice*.

### F2 — the passenger nav wrapped at 1200px (fixed)

`iteration-3`, `customer-app/my-reports-1200`. The seventh link wrapped
the bar onto a second row at the authoritative desktop viewport, where
there was visibly space.

Measured rather than guessed: the six original labels came to **556px**
inside a **587px** nav; a seventh took the set to **656px**.

Fixed by shortening three labels — `Search trips` → `Search`,
`My bookings` → `Bookings`, `My reports` → `Reports`. "My " says
nothing in an app where every screen is the signed-in passenger's own,
and "trips" is what the whole app is about. Measured after: **554px**,
one row. The page headings keep their longer names; a nav label is
allowed to be terser than the screen it opens.

**The bar still wraps at 768px**, which it did before this slice too
(556px into a 459px nav). Recorded, not fixed: CLAUDE.md already
carries this nav's collapse as a known gap, and spec 21 owns replacing
it wholesale with a passenger bottom tab bar. What this slice owed was
not making it worse at a width where it had been fine.

### F3 — the reports list showed the category twice (fixed)

`iteration-3`, `customer-app/my-reports-390`. Six consecutive rows read
**"Passenger report: Hardware"** in the first column beside a Category
column reading **"Hardware"**.

The form deliberately does not ask for a title, so
`passenger_report_title` derives one. That is right where it was
written for — the operator queue, whose first column would otherwise be
a list of blanks. On the passenger's own screen it is noise twice over:
"Passenger report" is the only kind of report visible here, and the
rest is the category.

Fixed by leading with the **category** and replacing the Category
column with **"What you said"** — the passenger's own description,
which is the most useful thing in the row and was not shown at all.

### F4 — two select prompts restated their own labels (fixed)

`iteration-3`, both forms. "What went wrong" above a prompt reading
"What went wrong?"; "Kind of problem" above "What kind of problem?".
A stutter to anyone reading, and read out twice by a screen reader.
Both are "Choose one" now; the operator picker follows `record-tap`'s
existing wording, "Select an operator".

### F5 — a form section shadowed the control inside it (fixed)

Found by the e2e run, not by reading the screenshot:
`getByLabel('Trip')` resolved to **two** elements, because
`ui-form-section` renders a labelled region and the section was called
"Which trip" while its only control was called "Trip".

That is a genuine ambiguity, not a selector problem — a screen reader
announces two near-identical names, one nested in the other. The
section is "Where this happened" now; the control keeps the name
`/record` and `/validate-ticket` already use for the same picker.

The same shadowing existed in the passenger form ("What happened"
containing "Tell us what happened") and was renamed to "The problem"
before it could bite.

### F6 — a reference and a date broke mid-token (fixed)

`iteration-4`/`iteration-5`, `my-reports-1200`. `INC-HXEWPC` wrapped
after the hyphen onto two lines, and `6 Sep 2026` broke to `6 Sep` /
`2026`. Half an identifier on each line is not something anyone can
read back over a phone. `whitespace-nowrap` on both cells.

## What the pass confirmed rather than found

- The booking-entry form renders as intended: the trip **named**, no
  operator picker, and no "Where" section — the booking already said.
- Status pills carry their label as text at every width, in the
  passenger's wording ("Received", "Being investigated") rather than
  the operator's.
- The location control opens on "Not attached" and never prompts for a
  permission the passenger did not ask to give.
- Axe clean on all four new screens, at every width.
