# 10-Booking-Modes — visual iteration 2

Iteration 1's five in-scope defects fixed, then re-captured into
`iteration-2/` at the same viewports.

## Exit criteria met

- `iteration-2/business-form-reservation-1440.png` — the seat-selection
  switch, its explanation now attached via `aria-describedby`, and the
  renamed **Pay as you go** nav item visible in the sidebar.
- `iteration-2/business-form-open-seating-1440.png` — switching booking
  mode swaps in **Enforce vehicle capacity**; the other switch is
  hidden, not reset.
- `iteration-2/places-picker-390.png` — "1 passenger — total NGN
  900.00", and the open-seating wording ("sit anywhere that's free").
- `iteration-2/places-confirm-390.png` — a Passengers row rather than a
  blank Seats row, `NGN 900.00 × 2`, and no false claim that anything
  is held.
- `iteration-2/not-configured-390.png` — heading now "Your journey", and
  the state says the departure is not open yet rather than that it is
  full.
- `iteration-2/seat-hold-inert-1440.png` — the amber notice explaining
  that the setting is saved but does nothing for an open-seating
  business, with the field still editable.
- `iteration-2/seat-map-390.png` — the reservation seat map, unchanged,
  for comparison.

Zero axe violations on every screen (asserted by the e2e specs, which
run axe on the places picker, the open-seating flow and both validator
screens).

Stopping at iteration 2: no in-scope defect above cosmetic remained,
well inside the five-iteration cap.

## Still outstanding

**Defect 6 from iteration 1 — the passenger nav at 390px — is not
fixed.** It is pre-existing, outside this slice, and needs a responsive
nav rather than a CSS tweak. It remains the most serious visual defect
on the authoritative passenger viewport, and it will keep showing up in
every customer-app capture until someone owns it.

Two states were not captured, and are covered by tests instead:

- **`sold_out`** — reachable only by exhausting a fixture departure's
  capacity, which would leave the fixture permanently full for every
  later run. Covered by `seat-picker.spec.ts`'s per-`status` tests,
  which assert the exact words in both modes.
- **Quick book end to end** — no seeded Business runs with seat
  selection off. Covered by `apps/booking/tests/test_quick_book.py` and
  by `seat-picker.spec.ts`'s quick-book case, which is the one that
  proves the seat map is *not* offered.
