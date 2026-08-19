# UI review — Phase 1 (Identity, Client, Business) — Iteration 1

Scope: `client-admin-app`'s `/register` screen (Slice 2) — the only new
screen Phase 1 added. `/login` and `/home` are unchanged from Phase 0's
own baseline and were not re-captured.

Captured at 390px, 768px, and 1440px (authoritative for client-admin-app)
in four states: empty, validation-error (client-side password-mismatch),
server-error banner (duplicate email), and success-redirect (`/home`
post-registration). 12 screenshots total, saved to `iteration-1/` and
all actually opened and visually reviewed, not just markup-reasoned-about.

## Findings

None. All 12 screenshots are clean at every captured viewport:

- No clipping, overflow, or broken alignment.
- Field-level error messages are correctly attached to their fields
  (`Business name`/`Email` required errors; `Confirm password`'s
  password-mismatch error).
- The server-error banner (duplicate email) renders consistently with
  the design language established by `shared-ui`'s `Alert` component.
- Spacing, type scale, and button styling are consistent with the
  Phase 0 baseline (`docs/ui-review/phase-0-foundation/baseline/`) — this
  screen reads as a sibling of `/login`, not a stranger.
- One screenshot (`register-server-error-768.png`) shows the "Create
  account" button in its `hover:bg-slate-700` state rather than the
  default `bg-slate-900` — confirmed as expected Tailwind hover styling
  (`projects/shared-ui/src/lib/button.ts`) triggered by Playwright's
  cursor remaining over the button after `.click()`, not a cross-
  viewport styling inconsistency.

No CSS/template/accessibility fixes were needed this iteration.

## Accessibility gap found and fixed (not a visual defect, but caught during this same review pass)

`register.spec.ts` had axe assertions on only 2 of the screen's 4 states
(empty load, success) — the validation-error and server-error-banner
states were exercised but never axe-checked, and no keyboard-only
completion test existed for `/register` at all (Phase 0's report already
flagged this same gap for `/login` on the non-customer apps as
unverified-but-low-risk; here it was simply absent). Fixed in the same
pass since these are safe, self-contained test additions with no
contract/data-model/auth changes:

- Added `AxeBuilder` assertions to the mismatched-passwords and
  duplicate-email tests.
- Added a new `is completable by keyboard alone` test, mirroring
  `e2e/customer-app/login.spec.ts`'s existing pattern.

All 6 tests in `register.spec.ts` pass in isolation. See the main
self-check report for a related finding: this addition pushed the full
Playwright suite's total auth-endpoint request count from 10 to 11
within one throttle window, which is a test-infrastructure/throttle-
budget finding, not a UI defect — not fixed in this loop, reported
separately.

## Exit

Exited on criteria (not the 5-iteration cap), after iteration 1. Zero
AXE violations, zero clipping/overflow/alignment defects, all states
consistent with the design language, keyboard-only completion confirmed.
Screenshots promoted to `docs/ui-review/1-identity-client-business/baseline/`.
