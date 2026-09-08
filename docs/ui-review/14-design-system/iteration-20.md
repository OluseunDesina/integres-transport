# Spec 14 slice 6b — visual review

Captured 2026-09-02 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

- **`iteration-20/`** — `validator-app`'s three screens and
  `client-admin-app`'s four auth screens plus `staff-invite`, as first
  rebuilt.
- **`iteration-21/`** — `validator-app` after F1.
- **`iteration-22/`** — `client-admin-app` after F2 and F3.

`client-admin-app`'s capture list gained `register`, `staff-invite` and
both invite-accepts. The invite screens are token-gated, so they
photograph their "invitation unavailable" branch — the state a real
stale link produces, and one that had never been reviewed. That turned
out to matter (F2).

## What the slice was for

The last eleven files holding `slate-*` literals, and with them four
defects: `validator-app` declaring the wrong surface profile, its
board/alight switch announcing as something it is not, both its screens
printing raw enums, and `file-upload-field` carrying the last 1.48:1
input border.

## Findings

### F1 — Fixed: the validator header broke apart at 390px

`iteration-20/validator-app/record-390.png`. "Record tap" wrapped to two
lines inside its own pill, "Validate ticket" wrapped, and "Sign out" was
pushed into a two-line box — a mark, a wordmark, two nav links, a bell
and a button on one fixed row.

**The consumer-profile flip caused it**, which is the point rather than
an argument against: every control got larger, and a layout that only
just fitted at console density stopped fitting. The fix is the one
`customer-app`'s header already uses — the nav takes its own full-width
row below `sm` — plus `whitespace-nowrap` on the links, so a label
cannot break mid-phrase.

### F2 — Fixed: an expired invite link showed Django's internal 404

`iteration-20/client-admin-app/staff-invite-accept-390.png` rendered:

> No StaffInvitation matches the given query.

That is `get_object_or_404`'s default detail, naming the model class,
shown verbatim to whoever clicked a stale invite link — a person who is
not yet a user of this system and for whom "StaffInvitation" means
nothing. Both invite-accept screens passed the server's `detail`
straight through.

They now say what happened and what to do: *"This invitation link is not
valid. It may have expired or already been used — ask whoever invited
you for a new one."* A bad token and a missing row are the same thing
from the reader's side, and neither is worth distinguishing.

The same family as slice 4's F5 (`proof_of_address` → "Proof of
address") and this slice's own raw-enum work, but the worst instance of
it found so far, because it is the only one shown to someone outside the
organisation.

### F3 — Fixed: `staff-invite` never got slice 4's console-form treatment

It was not in that slice's list of nine forms and five console screens,
so it still had a bare `<h1>`, no `ui-form-section`, no description, and
two hand-written per-field error methods over a private `fieldErrors`
helper — a copy of the pattern slice 4 removed seventeen of.

### F4 — Fixed while testing: a segmented radio cannot be clicked at its input

Not a screenshot finding but worth recording with them. `record.spec.ts`
called `.check()` on the `sr-only` radio and timed out: the label
covering it intercepts the pointer. That is correct behaviour — a real
user clicks the label — so the spec clicks the label. What matters is
that `sr-only` keeps the input focusable and arrow-selectable, which is
the whole reason the variant is built that way rather than with
`hidden`.

## Confirmed working

- **The consumer profile reaches `validator-app`** — 16px body type,
  44px-plus targets, on the one app spec 14 singles out for them.
- **Board/alight is a real radio group**, styled as the two large
  targets it was before. Arrow keys select and the group is one tab
  stop; both come from the browser.
- **No raw enums**: "Scheduled", "Boarded", "Journey in progress", and a
  service date read as "Thu, Sep 3".
- **Money reads the same everywhere** — "NGN 300.00", not the
  "300.00 NGN" this app alone rendered.
- **Tenant branding on the staff logins.** `client-admin-app` and
  `validator-app` show the operator's mark; validator keeps a
  "Validator" wordmark beside it so a conductor can tell the two apps
  apart. `super-admin-app` stays unbranded, per spec 14.
- Axe clean on every capture and throughout the e2e suite.

## Verification alongside the visual pass

- **1188 frontend unit tests**, up from 1179. Four clean builds, lint
  clean on all nine projects.
- **All four e2e projects green in a single pass**: `client-admin-app`
  83/83, `super-admin-app` 19/19, `customer-app` 14/14,
  `validator-app` 7/7.
- No backend change: no migration, no OpenAPI regeneration.

### The console apps did not move

Only `validator-app`'s `index.html` changed profile.
`shared-ui`'s `surface-profile.spec.ts` asserts both directions, and the
three console e2e suites passing unchanged is the second check.

### The dev database, again

`validator-app` needed three interventions before it ran clean, all
recorded before and all still true: a `FareJourney` left open by each
failed run blocks the next board tap and can only be closed, not pruned
(`TapEvent.journey` is `PROTECT`ed); `validate-ticket.spec.ts` consumes
a finite supply of unboarded fixture tickets that only `seed_e2e_users`
replenishes; and `super-admin-app`'s KYB queue is now **82 rows with the
fixture at row 82**, up from 79 at slice 6a and 36 when first recorded.
None is caused by this slice. All three are seeding problems.
