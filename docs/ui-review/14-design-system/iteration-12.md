# Spec 14 slice 4 — visual review

Captured 2026-09-02 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=client-admin-app --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-12/`** — the fourteen screens as first rebuilt.
- **`iteration-13/`** — after F1 and F2.
- **`iteration-14/`** — after F3 and F4, plus `business-kyb` and
  `seat-map`, which the flat capture list cannot reach.

The capture list gained the nine forms plus `white-label` and
`kyc-status`. Before this slice it photographed almost only lists: every
form in the console was unreviewed.

## What the slice was for

Every screen except the lists was still in the pre-rebuild language —
a hand-written `<h1>`, `slate-*` literals, no field grouping. Underneath
that, four things were actually broken: `fieldError` copy-pasted
seventeen times and mostly reporting "This field is required." whatever
had failed; server field errors flattened into one page-level sentence
with the field name discarded; success signalled three different ways;
and `seat-map` regenerating a seat map destructively on one click.

## Findings

### F1 — Fixed: three form sections were named after a field inside them

`iteration-12`'s e2e run, not a screenshot, surfaced this:
`getByLabel('Domain')` matched two elements. `ui-form-section` renders a
real `<section aria-labelledby>`, so a section titled "Domain"
containing a field labelled "Domain" gives a screen-reader user the same
word twice and makes "the Domain control" ambiguous.

Three collided — white-label's "Domain", schedule-form's "Route", and
trip-form's "Departure" (a substring of its own "Departure time"). Now
"Custom domain", "Journey" and "When it runs". driver-form's "Licence"
also became "Driving credentials", which additionally ends the
Licence/License spelling split on one screen.

**The rule this leaves behind: a section's title must not be, or
contain, the label of a field inside it.**

### F2 — Fixed: a contrast regression from the wrong surface token

`bg-slate-50` is `--color-ink-50`, which is `surface-muted`. Mapping it
to `surface-sunken` (ink-100) darkened the ground under `text-muted`
enough to fail AA — axe caught it on the fare grid's sticky corner cell,
and the same wrong mapping was in `business-kyb` and `seat-map`.

### F3 — Fixed: paired fields were unusable at 390px

`iteration-13/client-admin-app/schedule-form-390.png`. Five forms put two
fields side by side in a fixed `grid-cols-2`. At 390px that is ~150px
each, which does not fit `dd/mm/yyyy` plus the date picker's glyph. They
stack below `sm` now.

### F4 — Fixed: the nav and the page headings disagreed on case

`iteration-13` shows "Vehicle Types" in the sidebar above a "Vehicle
types" heading. Four items were Title Case and the rest were not, so the
nav read as two lists spliced together. All sentence case now, matching
the headings they link to.

### F5 — Fixed: KYC documents listed a raw enum

`iteration-14/client-admin-app/kyc-status-1200.png`. The document list
rendered `proof_of_address` while the upload select immediately below it
offered "Proof of address" — the same value written two ways on one
screen. `DOCUMENT_TYPE_OPTIONS` already had the labels.

### F6 — Recorded, not fixed: the KYC document list is unbounded

The same capture shows about eighty identical `proof_of_address` rows.
That is accumulated e2e cruft rather than a real client's data, but it
does show the list has no pagination and no cap. A real client would
have a handful; a busy one over years would not. Worth a decision, not
worth pre-empting here.

### F7 — Considered and kept: a tab label repeated as a heading

`business-kyb`'s Directors panel carries a "Directors" heading under a
"Directors" tab. That is mild redundancy, but the tab is a *control* and
the heading is document structure — a screen-reader user navigating by
heading needs it, and removing the section would take the landmark with
it.

## A blank screenshot that said nothing

`iteration-12` and `iteration-13` both captured `kyc-status` as three
**entirely blank** images and reported success. The capture entry pointed
at `/kyc-status`; the route is `/kyc`. Nothing in the harness notices a
page that rendered no app at all — worth remembering the next time a
capture looks odd rather than wrong.

## Confirmed working

- **Every server field error lands on its own field.** A 400 naming two
  fields now marks both, rather than showing the first one's message at
  the top of the page with nothing to say which field it meant.
- **Validation messages match the validator that failed** — a malformed
  email reads as malformed, a too-small number names the bound.
- **`seat-map` confirms before replacing a layout**, and is marked
  destructive only when there is an existing layout to destroy.
- **`route-form` and `business-kyb` split into tabs** — `ui-tabs`' first
  real consumers since slice 2 built it.
- **One success treatment** across every form: `ui-alert variant="success"`,
  which is now `role="status"` rather than `alert`, so a confirmation no
  longer interrupts a screen reader mid-sentence.
- Axe clean on every capture and inside the e2e suites.

## Verification alongside the visual pass

- 1091 frontend unit tests, up from 1056: client-admin 475 (was 446),
  shared-ui 247 (was 241). Four clean builds, lint clean on all nine
  projects.
- `client-admin-app` e2e **83/83**. `super-admin-app` 19/19,
  `customer-app` 13/14 (the seat-fixture known-red, unchanged),
  `validator-app` 6/7 — see below.
- No backend change: no migration, no OpenAPI regeneration.

**`validator-app`'s remaining failure is dev-database state, and was
diagnosed rather than assumed.** The seeded tap credential has a
`FareJourney` left open by an aborted run earlier the same day, and the
one-open-journey-per-passenger index rejects every later board tap. It
cannot be pruned: `TapEvent.journey` is `PROTECT`-ed, which is the same
shape `prune_e2e_test_data` already cannot clear for KYB documents. The
only way out is an alight tap through the app.

Two of that app's specs did need a real change, though: its success
outcomes are `ui-alert variant="success"`, so `getByRole('alert')` no
longer finds them. They query `status` now — the intended consequence of
the role change, not a workaround for it.
