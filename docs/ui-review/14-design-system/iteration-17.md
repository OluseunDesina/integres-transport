# Spec 14 slice 6a — visual review

Captured 2026-09-02 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… E2E_SKIP_SEED=1 npx playwright test --project=super-admin-app --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-17/`** — the eight screens as first rebuilt.
- **`iteration-18/`** — after F1.
- **`iteration-19/`** — after F2.

The capture list gained `client-invite`, which had never been
photographed, and `paystack-config` / `settlement-runs` / `seat-hold`,
which live at `/businesses/:id/…` and needed the `flows` hook slice 5
added.

## What the slice was for

`@layout` had never been in any slice's scope and was still entirely
`slate-*` — `NavShell` is the chrome on every client-admin *and*
super-admin screen. `@shared-ui` had no textarea, radio or checkbox, so
seven screens hand-rolled them, three still carrying the 1.48:1 input
border slice 1 replaced everywhere else. And super-admin's `home` was
still the Phase 0 placeholder.

## Findings

### F1 — Fixed: every column heading broke mid-word

`iteration-17/super-admin-app/kyb-queue-1200.png`. The KYB queue's
headers rendered **"VERTIC AL", "DIRECTO RS", "DOCUMEN TS"**.

`ui-table` sets `overflow-wrap: anywhere` on `th` and `td` alike — the
responsive-tables slice's fix for a long unbroken value setting a
column's minimum width. On a header it does the opposite of what it is
for: a heading is a short, known string the app chose, and a narrow
column simply made it longer than its own width.

Now `anywhere` on `td` and `break-word` on `th`, which still rescues a
pathological heading without splitting an ordinary one. That slice had
already carved out one exemption (`:is(button, a)`, after "Review"
rendered as three stacked characters); this is the second, and the two
share a cause — the rule was aimed at *data* and applied to the whole
table.

### F2 — Fixed: seven columns at 768px, none of them hidden

`iteration-18/super-admin-app/kyb-queue-768.png`, visible only once F1
stopped the headers from disguising it. Every cell wrapped to four or
five lines and the Review button was pushed off the right edge.

`ui-table`'s convention has three tiers — secondary at `md`, **the long
tail at `lg`** — and this screen used only two, so all seven columns
appeared together the moment `md` was crossed. Vertical and Documents
are that tail and move to `lg`, re-flowing into their own
`md:block lg:hidden` sub-line. Client and Directors stay, because that
screen's own comment records why a reviewer needs to see who they are
approving before opening the dialog.

**The responsive-tables guard passed throughout.** It measures fit,
overflow and column parity — the table did scroll, correctly, and every
hidden column had a matching cell. It cannot measure legibility, which
is what the screenshots are for.

### F3 — Recorded, not fixed: the sidebar keeps 64px at 390px

`iteration-19/super-admin-app/kyc-queue-390.png`. `NavShell` collapses
to icons but never goes away, so a 390px screen gives the content 326px
and the Client column wraps to three lines.

Unlike `customer-app`, 390px is not this app's authoritative viewport —
it is a back-office console — and the tables do fit and scroll
correctly. Making the rail an off-canvas drawer is a real design change
that would affect `client-admin-app` identically, so it is named rather
than smuggled into a re-skin.

### F4 — Recorded, not fixed: the email in a 20px heading, again

Same as slice 5's F4, now in a second app: with no `firstName` the
greeting falls back to the email and wraps mid-token. The heading
prefers `firstName` now (nothing read it before), so this is only the
fallback — but it is the fallback both e2e fixtures hit, and two
`login.spec.ts` files assert the email is in the `<h1>`. One decision
would settle it for both apps.

## Confirmed working

- **`@layout` is tokenised**, so the console chrome finally responds to
  a tenant's brand: `NavShell`'s active nav item is `primary-subtle`
  rather than a fixed grey.
- **An unread notification says so.** It was a `bg-slate-50` tint and
  nothing else — colour as the only status indicator, and a tint faint
  enough to barely be one; a screen-reader user got no signal at all.
- **The review dialogs use real form controls** — `ui-radio-group` over
  native inputs sharing a name (so arrow keys work), `ui-textarea` with
  a label association and a visible reason requirement.
- **`paystack-config` says why it refused.** Three of its four fields
  bound neither `invalid` nor `errorMessage`.
- **`home` is a landing page**, not `Platform staff: true`.
- Axe clean on every capture and throughout the e2e suite.

## Verification alongside the visual pass

- **1179 frontend unit tests**, up from 1136: `shared-ui` 301 (was 272 —
  the three new primitives), `super-admin-app` 90 (was 78), `layout` 46
  (was 44). Four clean builds, lint clean on all nine projects.
- **All four e2e projects green**: `super-admin-app` 19/19,
  `client-admin-app` 83/83 (`--workers=1`), `customer-app` 14/14,
  `validator-app` 7/7.
- No backend change: no migration, no OpenAPI regeneration.

### Two anticipated consumers that did not exist

The plan named three consumers for `ui-checkbox`. Two were wrong:
`staff-list`'s bare checkbox had **already** been replaced by a
confirm-dialog action in an earlier slice (only a comment mentioning it
survived), and `schedule-form`'s is a *group* of seven weekday boxes —
a different component, already correctly built with a `fieldset`,
`legend`, `min-h-11` rows and `border-control`, with nothing wrong with
it. So `ui-checkbox` ships with one real consumer, `paystack-config`.
Recorded rather than papered over by inventing a use for it.

`ui-textarea` and `ui-radio-group` landed with three consumers each as
planned.
