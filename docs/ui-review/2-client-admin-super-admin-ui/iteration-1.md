# UI review — Phase 2 (Client-Admin + Super-Admin UI) — Iteration 1

Scope: all 7 screens Phase 2 added — `client-admin-app`'s Businesses
(list/create/edit), Staff (list/invite), KYC Status, White Label; and
`super-admin-app`'s KYC Queue, KYB Queue (each with the `ui-confirm-dialog`
approve/reject modal — the first CDK dialog in the repo), and Invite
Client. `NavShell` (first used this phase, now in both apps) is exercised
on every screenshot below rather than reviewed separately.

Captured at 390px, 768px, and 1440px (authoritative for both admin apps)
across every reachable state per screen — 40 states × 3 viewports = 120
screenshots, saved to `iteration-1/`. Full rigor per the user's explicit
choice: every image actually opened and judged, not sampled.

## Review method

120 screenshots is too much to review inline without crowding out the
rest of the session, so review was delegated to 3 parallel agents split
by screen group (Businesses+Staff; KYC Status+White Label; the two
queues+Invite Client), each given the exact judgment criteria from
`docs/self-check.md` §10.6.2 and instructed to open every assigned image.
Their combined findings were then **independently re-verified** against
the running app before any fix — several read as real from a screenshot
but weren't, and that distinction mattered:

- **False alarms, confirmed via live re-check, not fixed**: two "washed
  out"/"illegible" disabled-button findings on the confirm dialog and one
  "stuck on Loading forever" finding on two list screens all turned out
  to be the capture script itself screenshotting mid-CSS-transition or
  before an async load resolved — not settled product states. Confirmed
  by re-querying computed styles/DOM state live (and, for the contrast
  claim, by running axe directly against the settled state: zero
  violations) rather than trusting the screenshot alone. A third finding
  ("large unused right-hand margin at 390/768") was confirmed a rendering
  artifact of how screenshots are displayed for review, not a real layout
  bug — direct DOM measurement showed `<main>` spans the full viewport
  width with zero extra margin. The capture script's settle-wait was
  fixed (400ms → 700ms before each screenshot, plus waiting for real row
  content before capturing "populated" states) and the affected screens
  fully recaptured; the corrected screenshots now match what the live
  re-checks already showed.
- **Real, functioning-as-designed, not fixed**: the KYC/KYB queue tables
  genuinely overflow at 390px and looked "clipped" in review — but the
  wrapper's `overflow-x-auto` (`ui-table`) does work (confirmed:
  `scrollWidth` 591px vs `clientWidth` 340px, horizontally scrollable).
  Content isn't lost, just not fully visible without scrolling and with
  no visual affordance hinting at that. Judged minor/polish, not a
  blocker, and left as-is rather than adding a scroll-shadow for a case
  that already works.
- **Native `<select>`/file-input styling** flagged by two reviewers as
  "unstyled/default-browser" — judged not a defect: native form controls
  carry their own OS-level accessibility affordances, and no screen in
  this phase's scope calls for custom-styled selects (§4 of the spec
  explicitly keeps `ui-select` a thin CVA wrapper, not a redesign).

## Findings fixed

1. **[Real, WCAG AA] `ui-button`'s disabled state relied on
   `disabled:opacity-50`**, which blends any variant's color toward
   whatever page background sits behind it — on the paginator's disabled
   Previous/Next buttons this settled around 2.4–3.8:1, under the 4.5:1
   minimum (confirmed via axe on the live, non-transitioning state, not
   a screenshot). Fixed in `projects/shared-ui/src/lib/button.ts`: the
   disabled state now uses explicit `bg-slate-100`/`text-slate-700`
   (the same pairing `ui-status-pill`'s neutral tone already uses
   elsewhere in this app) instead of opacity, for every variant. New
   `button.spec.ts` case locks this in. Re-verified with axe: zero
   violations.
2. **[Real, consistency] List-screen error states rendered as bare red
   text** (`<p role="alert" class="text-sm text-red-600">`) while every
   other error state in both apps uses the bordered/tinted `ui-alert`
   component — genuinely inconsistent, confirmed side-by-side in the
   same screenshot (KYC Status page shows both patterns at once: a
   proper `ui-alert` for the upload error, bare text for the load error).
   Fixed in all 6 places it occurred: `business-list.html`,
   `staff-list.html`, `kyc-status.html`, `white-label.html`,
   `kyc-queue.html`, `kyb-queue.html` — swapped to `<ui-alert>`, added
   the import where missing (3 of the 6 components).
3. **[Real, WCAG] `NavShell`'s nav links were far under the 44×44px
   minimum tap target** — measured live at 390px: heights of 20–40px,
   widths as small as 31px for "Staff". Fixed in
   `projects/layout/src/lib/nav-shell.ts`: nav links now use
   `inline-flex min-h-11 items-center px-1`, matching the `min-h-11`
   convention every other interactive control in this app already
   follows. `ui-button`-based controls (Review, Send invitation, etc.)
   were already compliant — `min-h-11` has been in `Button`'s template
   since Phase 2 Slice 1.

No data-model, API-contract, money, or auth/tenancy change was needed for
any of the above — all three fixes stayed inside CSS/template/component
composition, the same boundary every other slice's in-loop fixes have
respected.

## Re-verification after fixes

`ng lint`/`ng test` for `shared-ui` (33/33), `client-admin-app` (66/66),
`super-admin-app` (32/32), `layout` (6/6) — all pass, no regression.
`ng build` clean for both apps. Full Playwright run, all 3 apps
combined: 43/43 pass in one serial invocation (previously this required
per-file isolation to avoid the throttle-budget and test-pollution
issues found in Slices 4–6 — both are now genuinely fixed, not routed
around; see the main self-check report). Affected screens fully
recaptured post-fix and spot-checked directly: error states now show the
bordered `ui-alert` consistently, nav links measure 44px tall live.

## Exit

Exited on criteria (not the 5-iteration cap), after iteration 1. Zero
AXE violations across the full e2e suite (every state assertion
still passes), zero clipping/overflow/collision/misalignment on
re-checked screens, all states render correctly including stressed
content (45 accumulated Businesses with long generated names render
without breaking the table; the longest realistic KYC rejection reason
wasn't separately stress-tested this round — named in the self-check
report's residual 5%). Screenshots promoted to
`docs/ui-review/2-client-admin-super-admin-ui/baseline/`.
