# Spec 18 slice 2 — visual review

Captured 2026-09-07 via `e2e/ui-review-capture.ts`, at 390 / 768 / 1200.

```bash
UI_REVIEW_SPEC=18-staff-booking UI_REVIEW_DIR=iteration-1 E2E_SKIP_SEED=1 \
  npx playwright test --project=client-admin-app --grep @ui-review
```

Two entries, because the screen is two states and the second cannot be
reached from a URL. `counter-booking` is the cold screen — a passenger
lookup and nothing else, which is the whole screen until someone is
resolved. `counter-booking-filled` is a **flow**: it types the seeded
address, waits for the resolved-passenger card, and photographs the
departure, seats and payment sections that only exist after that.

## One defect in the screen

### F1 — the passenger card showed no name at all (fixed)

`iteration-1`, all three `counter-booking-filled-*`. The card read:

```
                              [ Change passenger ]
e•••••••••••@example.com
```

An empty line, then a masked address. The seeded passenger accounts
carry no `first_name`/`last_name`, so `{{ found.first_name }}
{{ found.last_name }}` rendered as whitespace — and on the one card
whose entire job is *"is this the right person?"*, a blank line reads as
a lookup that failed rather than an account with no name on it.

This is the same failure `apps.booking.manifest._passenger_name` already
has a fallback for, and its docstring says why: *"A blank cell beside a
seat number is worse than an imperfect name: it reads as 'nobody'."*

The manifest's own fallback — the email's local part — is **not
available here**, because the local part is exactly what masking hides.
So the honest answer is to say so:

```
No name on this account
e•••••••••••@example.com
```

Fixed in `counter-booking.ts`'s `passengerName()`, with a unit test.

## What the pass confirmed rather than found

- **The steps read in the order the conversation happens.** Nothing
  below "Who is travelling" exists until a passenger is resolved, which
  is what the cold capture shows: the screen is one field.
- **The no-cash limitation is on the screen, not in a doc.** "There is
  no cash drawer in this system. You can settle from the passenger's own
  wallet, or leave the booking unpaid for them to pay from their app."
  An agent meets the constraint before they hit it, not after.
- **The wallet checkbox states its own failure mode** — "If their
  balance is short, the seats stay held and nothing is charged" — so the
  outcome an agent most fears is answered before they tick it.
- **No section title repeats a control's label.** "Who is travelling"
  over "Passenger email", "Trip and stops" over "Departure". Both were
  renamed after the first e2e run failed on a strict-mode violation:
  `ui-form-section` renders a labelled region, so a section named
  "Departure" around a select of the same name is announced twice and
  matched twice. A real a11y defect, caught as a selector complaint.
- **390 holds without horizontal scroll.** The passenger card stacks,
  the paired selects go to one column, and the seat chips wrap. No table
  on this screen, so `responsive-tables.ts` has nothing to add.
- Axe clean at all three widths, on both the cold and filled states.
