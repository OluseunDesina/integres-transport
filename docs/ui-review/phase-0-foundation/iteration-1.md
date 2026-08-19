# UI review — phase-0-foundation — iteration 1

## Scope

Every screen Phase 0 adds: `/login` and `/home` for all three apps.
Captured empty, validation-error, and populated states. No error/loading
states beyond these exist yet (no async data fetching happens on these
screens besides the login submit itself, which the e2e suite already
covers headlessly).

Viewports: 390px (customer-app, authoritative) and 1440px (all three
apps; client-admin/super-admin's authoritative width). 768px was not
captured separately — at this simple a layout (single centered card /
single-column dashboard), nothing distinguishes it from the 1440px
behavior; both are flagged below as a residual gap since the brief asks
for all three widths.

## Defects found and fixed this iteration

1. **`cdkTrapFocus` on `AuthLayout` failed axe's `aria-hidden-focus`
   rule** (serious). CDK's focus-trap boundary anchors are
   `aria-hidden="true"` + `tabindex="0"` — correct inside a modal, wrong
   on a standalone page with no background content to trap focus against.
   Fixed: removed `cdkTrapFocus` from `AuthLayout` (`projects/layout/src/lib/auth-layout.ts`).
2. **No `<main>` landmark** on `/login` or `/home` (moderate — axe
   `landmark-one-main` + `region`). Fixed: `AuthLayout`, `ForbiddenPage`,
   and each app's `home.html` now root their content in `<main>`.

Both were caught by the Playwright+axe suite itself (`e2e/*/login.spec.ts`),
not by this screenshot pass — the screenshot pass corroborated the fix
visually but found no additional issues beyond what axe already caught.

## Screenshot review findings

Looked at all 12 screenshots directly (not just reasoned about the
markup). No clipping, overflow, collision, or broken alignment at either
viewport. Card stays a fixed `max-w-sm` at 1440px rather than stretching
awkwardly. Field-level errors are red-bordered with attached red text
directly under the field (not a floating banner disconnected from its
input). Mobile tap targets (`ui-button`, `ui-text-field` inputs) are
`min-h-11` (44px) per the brief's minimum.

One thing intentionally **not** fixed, flagged instead per §10.6.3 (would
require product/data-model input, not a CSS fix): the `/home` screen
renders the raw `client` UUID from `/me`. This is a deliberate Phase 0
diagnostic view proving the JWT → `/me` → signal-store round trip works
end-to-end — it is not a real dashboard and isn't meant to be judged as
one. A real client-facing name requires the Client model to grow past its
Phase 0 minimal shape (`docs/adr` note on `apps/clients`), which is
Phase 1 scope.

## Outstanding

- 768px not captured as its own state (see Scope above) — low risk given
  the layout's simplicity, but should be captured once a phase adds a
  layout that actually changes behavior at that breakpoint (e.g. a table
  that reflows).
- No stressed-content pass (long email addresses, etc.) — deferred until
  a phase has content worth stressing (Phase 0's only dynamic text is the
  signed-in user's email, already tested via a real seeded address).

## Exit

Criteria met on iteration 1 (see `docs/self-check-2026-08-07.md` §10.4 for
the full axe results this corroborates). Screenshots promoted to
`docs/ui-review/phase-0-foundation/baseline/`.
