# 14-Design-System: Visual identity, token layer, and UI rebuild

Second spec of the Transit OS adoption arc, and a prerequisite for
every spec after it that adds a screen. See
`README-transit-os-adoption.md` for the arc.

## Scope and non-goals

The arc adopted the briefs' **UX Requirements**, **Tailwind Design
Direction** and **Code Quality Constraints** as binding, but the other
specs in it apply those only to the screens they add. That would leave
~20 new screens built in the language being replaced and ~58 existing
screens untouched. This spec owns the visual half for the whole
workspace, which is why it is sequenced ahead of every spec that adds
a screen.

### Three findings that make this necessary

1. **There is no design token layer.** All four `styles.css` files
   contain exactly `@import "tailwindcss";` — no `@theme`, no brand
   colour, no type scale, no elevation. Styling is raw utility classes
   across 58 templates, and `@shared-ui` components hard-code them in
   class bindings (`[class.bg-slate-900]="variant() === 'primary'"`,
   `button.ts:15`). There is nothing for the Tailwind Design Direction
   to attach to.

2. **White-labeling does not white-label anything.** `WhiteLabelConfig`
   stores `logo`, `primary_color` and `secondary_color`; the only code
   that reads them is the form that edits them. For a platform whose
   premise is white-labeled tenants, that is a live product defect.
   `GET /white-label/resolve/` **already returns all of them** —
   `WhiteLabelResolverService` keeps `client_id` and discards the rest
   (`white-label-resolver.service.ts:25`).

3. **The screens are plain rather than wrong.** The routes list has a
   competent sidebar and table but no page-header pattern, no filter
   bar, no action menu, no cards or elevation. It renders record status
   as a **write toggle inside a read table** — six list screens do
   (`route`, `stop`, `vehicle`, `vehicle-type`, `driver`, `schedule`) —
   against both "badge systems for statuses" and this repo's own
   "colour is not the only status indicator" bar. `customer-app` is
   further off: no brand presence, flat hierarchy, raw native selects.

### In scope

A visual identity, a token layer, tenant theming, an uplifted and
extended component library, and a rebuild of every screen in all four
apps to the briefs' patterns.

### Non-goals

- **No functional change.** Screens do the same things through the same
  stores and endpoints. One deliberate exception, below: the in-table
  status toggle.
- **No backend change of any kind.** Tenant theming consumes a response
  that already carries the data. No model, no endpoint, no migration.
- **No component-library dependency** (Material, PrimeNG). Tailwind
  plus Angular CDK, as the briefs specify and this workspace already
  does. A library would re-skin faster and then own our accessibility
  contracts, our density model and our upgrade cadence.
- **No dark mode.** A reasonable follow-up that the token layer makes
  tractable; adding it here doubles the review surface.
- **No new bespoke iconography.** The existing `ui-icon` set is
  extended as needed, not replaced.
- **No motion/animation system** beyond state transitions already
  present, and none that ignores `prefers-reduced-motion`.

## Data model changes

**None.**

## API surface

**None.** `GET /white-label/resolve/` already returns `client_id`,
`name`, `logo`, `primary_color`, `secondary_color`, `email_sender_name`
and `terms_url` (`WhiteLabelResolveSerializer`). This spec starts
consuming four fields that are already on the wire.

## The identity

Proposed here for review as a document, before it exists as code.

### Where the identity budget is spent

**Not on a bespoke neutral ramp.** The existing slate scale is
well-tested, accessible and familiar; replacing it buys nothing and
risks contrast regressions across 58 screens. Identity comes from the
brand hue, the type treatment, the density model and the structural
patterns — which is also where the briefs put it ("professional,
operational, data-dense but readable, modern enterprise, trustworthy").

### Brand — "Transit Blue"

Blue reads as infrastructure and signage rather than as retail, works
across the three target markets without cultural collision, and is far
enough from the semantic green/amber/red that a brand-coloured control
never reads as a status.

| Step | Hex | Used for |
|---|---|---|
| 50 | `#EFF4FF` | Tinted surfaces, selected rows |
| 100 | `#DBE5FE` | Hover on tinted surfaces |
| 200 | `#BFD1FE` | Borders on tinted surfaces |
| 300 | `#93B4FD` | Disabled brand fills |
| 400 | `#608DFA` | Focus rings on dark |
| 500 | `#3B6BF6` | Accents, chart primary |
| 600 | `#2549EB` | **Primary action fill** |
| 700 | `#1D37D8` | Primary hover, links on light |
| 800 | `#1E30AF` | Primary active |
| 900 | `#1E2F8A` | Brand text on light |
| 950 | `#172054` | Deep brand surfaces |

### Semantic tones

Deliberately darker than the Tailwind defaults currently used, because
several are set as text on a tinted background where the 500 steps sit
close to the AA floor.

| Tone | Fill | Text-on-light | Current usage it replaces |
|---|---|---|---|
| Success | `#ECFDF5` | `#047857` | `text-emerald-700` in `alert.ts` |
| Warning | `#FFFBEB` | `#B45309` | `text-amber-800` |
| Danger | `#FEF2F2` | `#B91C1C` | `text-red-700` |
| Info | `#EFF4FF` | `#1D37D8` | — (new) |

### Type

**Inter**, with a full system fallback stack, self-hosted (no external
font request — this workspace has no CDN dependencies and should not
acquire one). Chosen for legibility at 12–14px, which is most of a
console.

`font-variant-numeric: tabular-nums` on every monetary and tabular
figure. Proportional digits make a column of fares impossible to scan
and are the single most common typographic failure in an operations
table.

| Step | Console | Consumer |
|---|---|---|
| xs | 12px | 14px |
| sm | 13px | 16px |
| base | 14px | 16px |
| lg | 16px | 18px |
| xl | 20px | 20px |
| 2xl | 24px | 24px |
| 3xl | 30px | 36px |

### Space, radius, elevation

4px spacing grid. Radius `sm 4 / md 6 / lg 8 / xl 12 / full`.
Three elevation levels, low-alpha and subtle — the brief asks for
"subtle shadows", and heavy shadow in a dense table is noise.

### Verification, not assertion

Every foreground/background pairing is checked against WCAG AA (4.5:1
body, 3:1 large text and UI boundaries) by an automated check in the
token slice, and against AAA (7:1) for the Senior Mode token set spec
20 requires. **The values above are proposals**; a pairing that fails
moves by one step and the spec is updated to match. Contrast is
measured, never eyeballed.

## Token layer

A new `frontend/projects/shared-ui/src/theme.css` holding a Tailwind v4
`@theme` block, imported by all four `styles.css` files above their own
`@import "tailwindcss"`.

Tokens as CSS custom properties: `--color-brand-*`, `--color-surface-*`,
`--color-text-*`, `--color-border-*`, semantic tones, `--text-*`,
`--radius-*`, `--shadow-*`, and density variables (`--row-height`,
`--control-height`, `--gutter`).

### Two surface profiles, one token set

`data-surface="console"` (the three operator apps — dense, compact
type, tight grid) and `data-surface="consumer"` (`customer-app` —
spacious, larger type, mobile-first). Set once on the app shell root;
components read tokens and never branch on the profile themselves.

This composes with spec 21's `data-senior="true"`, which is a third
override on the same custom properties rather than a parallel system.

### The class-binding rewrite

`@shared-ui` components currently express variants as literal utility
class bindings. Those become token-driven classes so a token change
reaches every component. This is mechanical but touches every component
template, which is why it is its own slice.

## Tenant theming

`WhiteLabelResolverService` keeps the branding it already receives and
applies it as custom properties on `document.documentElement`, through
the `provideAppInitializer` hook that already runs it at boot. Three
rules, because each is a way to ship something broken:

1. **Validate before injecting.** A tenant-supplied string is written
   into a style. Only a strictly-matched `#RGB`/`#RRGGBB` is accepted;
   anything else is ignored and the default identity stands. No
   pass-through of arbitrary text into CSS.
2. **Derive the ramp.** Tenants supply one primary and one secondary,
   not eleven steps. The 50–950 ramp is generated from the supplied
   hue by a pure function with its own unit tests.
3. **Check contrast and flip.** If the derived 600 step fails AA
   against white, the on-brand text token flips to the dark end rather
   than shipping unreadable buttons. A white-label platform that lets a
   tenant make their own product illegible has no accessibility story.

Resolution 404s in local dev and for any unconfigured Client — the
default identity applies and nothing blocks boot, exactly as the
service already behaves for `clientId`.

Logo and Client name replace the hard-coded "Client Admin" / "Integra
Travel" wordmarks in the shells when present.

`super-admin-app` is **not** themed. It is the platform's own console,
not a tenant surface, and a super-admin looking at a tenant-coloured
platform tool is a way to act on the wrong system.

## Component library

### Uplift the twelve existing

`alert`, `button`, `confirm-dialog`, `empty-state`, `icon`,
`paginator`, `select`, `stat`, `status-pill`, `table`, `text-field`,
`toggle`.

**Public APIs and behavioural contracts are preserved, not redesigned
away.** Specifically kept: `ui-select`'s `hint` (wired through
`aria-describedby`, carrying both hint and error ids when invalid);
`ui-toggle`'s `describedBy`; `ui-alert`'s `warning` variant; and the
rule that `ui-text-field`/`ui-select` render a validation error only
when the parent binds both `[invalid]` and `[errorMessage]`. Each of
those exists because a real defect was found; a restyle must not
quietly drop them.

`ui-button` gains a `ghost` variant and icon-only support (needed by
action menus and toolbars), and `ui-status-pill` gains the tone set the
new semantic tokens define.

### Add the primitives the briefs require

| Component | Purpose |
|---|---|
| `ui-page-header` | Title, description, breadcrumb slot, action slot. Every screen |
| `ui-filter-bar` | Search, filter controls, active-filter chips, clear-all |
| `ui-action-menu` | CDK `Menu`. Replaces bare text links in table rows |
| `ui-drawer` | CDK `Dialog` in a side-panel configuration, with focus management |
| `ui-skeleton` | Loading placeholders, replacing bare spinners |
| `ui-tabs` | Sectioned detail screens |
| `ui-form-section` | Titled, described grouping within long forms |
| `ui-toolbar` | Bulk/contextual actions above a table |
| `ui-density-toggle` | Compact/comfortable table rows |
| `ui-export-button` | Format menu + "current view / all" choice (spec 16) |

`ui-chart` (spec 16), `ui-map` (spec 20) and `ui-countdown` (spec 21)
stay owned by their specs and are built to these tokens and
conventions.

Every overlay uses CDK for focus management. `@layout`'s `AuthLayout`
already documents why a full page is **not** focus-trapped; drawers and
dialogs are, and that distinction is preserved.

## Per-app rebuild

### `client-admin-app` — 35 screens

- `ui-page-header` on every screen; consistent title/description/action
  placement.
- `ui-filter-bar` on every list. Several lists have no filtering at all
  today.
- **In-table write toggles become status badges plus an explicit
  action** on all six affected lists (`route`, `stop`, `vehicle`,
  `vehicle-type`, `driver`, `schedule`). See below — this is the one
  behavioural change in the spec.
- `ui-action-menu` replacing per-row text links.
- `ui-drawer` for contextual edits that do not deserve a route.
- Sticky table headers, density control, skeleton loading, and a
  consistent empty/error treatment.
- Top bar with quick actions alongside the existing sidebar.

### `customer-app` — 11 screens

A consumer direction, not a console: brand presence, real typographic
hierarchy, card-based search results, a visible step indicator through
search → seats/places → confirm → pay, and properly styled controls in
place of raw native selects.

The mobile navigation fix is **spec 21's**, not duplicated here. This
spec supplies the tokens and components it uses; spec 21 owns the
bottom-tab-bar behaviour and its breakpoint tests. Whichever lands
first, the other consumes it — coordinated in the roadmap, not
implemented twice.

### `super-admin-app` — 9 screens

Same console patterns. Unthemed, per the tenant-theming rule above.

### `validator-app` — 3 screens

Adopts tokens and components, and **keeps its bespoke top bar**. It is
a handheld used one-handed in a vehicle, not a back-office console;
`@layout`'s `NavShell` was rejected for it deliberately and that
decision stands. Its targets are sized for the consumer profile even
though its palette is the console one — a conductor is not reading a
data table.

## The one behavioural change

Six list screens render an active/inactive **toggle** inside a table
row. That is a write control in a read surface: it is one mis-tap from
deactivating a vehicle, it is unlabelled beyond its colour, and it gives
no confirmation.

It becomes a **`ui-status-pill` plus an explicit action** in the row's
action menu, going through `ui-confirm-dialog`. The same endpoint, the
same permission, one deliberate step instead of one accidental one.

Two coordination notes:

- **`route-list` is superseded by spec 19**, which replaces `is_active`
  with a four-state lifecycle and its own status endpoint. Whichever
  lands first wins for that screen; the other five are this spec's.
- The affected e2e specs assert on the toggle and are **updated in the
  same slice**, never disabled.

## Edge cases

| Case | Expected behaviour |
|---|---|
| No white-label config (local dev, unconfigured Client) | Default identity; boot unaffected |
| Tenant supplies a malformed colour | Ignored; default identity; no string reaches CSS |
| Tenant supplies a colour failing AA against white | On-brand text flips to dark; button stays readable |
| Tenant supplies only a primary | Secondary derived from the default identity, not from the primary |
| Tenant logo fails to load | Falls back to the Client name as a wordmark, never a broken image |
| Very long Client name in the shell | Truncates with a `title`, and the accessible name stays complete |
| Console profile at 390px | ~~Tables scroll inside their own `overflow-x` container; the page never scrolls horizontally~~ **Superseded by the responsive-tables slice:** a table that scrolls sideways to reach the only control in the row is not usable. Tables now *fit* — secondary columns hide below `md`/`lg` and their values re-flow into a sub-line under the primary cell. The `overflow-x` container stays as a safety net, not the mechanism. |
| Consumer profile at 1200px | Content is width-capped and centred, not stretched |
| Senior Mode on top of the consumer profile | Composes; Senior tokens override, no third layout |
| `prefers-reduced-motion` | All non-essential transitions removed |
| Density set to compact with long cell content | Wraps or truncates with a title; never clipped without recourse |
| A screen mid-rebuild in a shipped slice | Old and new patterns coexist visually within a slice boundary but never within one screen |

## Failure modes

- **Accessibility regression under a restyle.** The most likely damage
  this spec can do. Mitigated by axe running on every screen before and
  after, contrast measured rather than judged, and the preserved
  component contracts listed above being individually tested.
- **Silent loss of a hard-won behaviour.** `ui-select`'s `hint`,
  `ui-toggle`'s `describedBy` and the `[invalid]`/`[errorMessage]`
  binding rule each came from a real defect. Each keeps its existing
  test, and those tests are not rewritten during the uplift.
- **Test breakage misread as noise.** Restructuring 58 templates will
  legitimately break Karma and Playwright assertions that match on
  rendered text and structure. They are updated with the screen, in the
  same slice. **No test is skipped or deleted to make a slice green** —
  that is how `customer-app`'s suite silently rotted before.
- **Tenant colour injection.** Strict hex validation is the control.
  Worth stating plainly: this is the only place in the frontend where
  tenant-controlled data becomes style.
- **Scope drift into functional change.** Every slice is reviewed
  against "same stores, same endpoints, same behaviour", with the one
  documented exception.
- **Two specs owning one component.** `ui-filter-bar`, toasts, top-bar
  quick actions, sticky headers and density move here from spec 16,
  which is edited to consume rather than define them.

## Test plan

### Unit (Karma)

- **Token/ramp derivation**: a pure function, tested directly — valid
  hex in, eleven steps out; malformed input rejected; the contrast flip
  triggers at the right threshold.
- `WhiteLabelResolverService`: applies properties on success, applies
  nothing on 404, ignores malformed colours, still resolves `clientId`
  as before (its existing tests must pass unchanged).
- Every uplifted component keeps its existing spec **passing without
  modification** wherever the assertion is behavioural rather than
  visual. Where a spec asserts a literal utility class, it is rewritten
  to assert the behaviour instead — an improvement, and noted in the
  slice.
- Every new component: rendering, keyboard interaction, ARIA wiring,
  and the disabled/loading/empty states.
- `ui-action-menu` and `ui-drawer`: focus moves in on open, returns to
  the trigger on close, `Escape` closes, focus is trapped while open.

### Accessibility

Axe with **zero violations** on every screen in all four apps, at
390/768/1200px, before and after each slice. Both surface profiles.
Plus a themed run with a tenant colour applied, since theming can only
break contrast at runtime.

Keyboard traversal of the primary flow in each app, with visible focus
throughout.

### E2E (Playwright)

Per project (`--project=…`, never bare — the four interfere). Existing
suites are the regression net and must be green at the end of every
slice. Per `docs/self-check-2026-08-26-spec11.md`, **every** project is
run, not only the one changed.

### Visual review

The §10.6 loop, per slice: capture every affected screen at 390, 768
and 1200px, **read every screenshot**, record findings in
`docs/ui-review/14-design-system/iteration-N.md`, fix, re-capture,
re-verify. A baseline capture of the current UI is taken **before slice
1** so the change is reviewable as a diff rather than asserted.

## Migration impact

**No database migration.** No schema, no backfill, nothing destructive.

The only migration-shaped risk is in the frontend: `theme.css` must be
imported before the Tailwind import in each `styles.css` for `@theme`
to take effect, and the class-binding rewrite must land with the token
layer rather than after it, or components briefly reference tokens that
do not exist.

## Suggested implementation slicing

Six slices, stop for review between each, so breakage is contained to
one app at a time.

1. **Identity, tokens, theming.** `theme.css`, the `@theme` block, the
   ramp-derivation function and its contrast check, `WhiteLabelResolverService`
   applying branding, the two surface profiles. Plus the pre-rebuild
   baseline screenshot capture. No screen changes yet.
2. **`@shared-ui`.** Uplift the twelve, add the ten new primitives, and
   the class-binding rewrite.
3. **`client-admin-app` — shell and lists.** Top bar with quick
   actions, page headers, filter bars, action menus, the six
   toggle→badge conversions, sticky headers, density, skeletons.
4. **`client-admin-app` — forms, details, dialogs.** Form sections,
   drawers, tabs, consistent validation presentation.
5. **`customer-app`.** The consumer rebuild.
6. **`super-admin-app` and `validator-app`.**

Plus one slice this list did not anticipate, taken between 3 and 4 by
decision: **responsive tables at 390px**, across all three
table-bearing apps at once. It could not sit inside slice 3 — a mobile
layout touches every list simultaneously, and bundling it would have
made that slice's review two things at the same time — and it could not
wait for slices 5 and 6, because the defect was in `customer-app`, the
phone app, as much as in the console.

## Implementation note (Slice 1, done)

Built 2026-08-30. **Scope was widened by decision before starting**: the
retokening of the existing twelve components was folded in from slice 2,
so the tokens landed with a real consumer rather than as a token layer
nothing referenced. Slice 2 keeps the ten *new* primitives.

Delivered: `theme.css`, self-hosted Inter, `lib/theme/color.ts` and
`brand-theme.service.ts`, a `branding` signal on
`WhiteLabelResolverService`, surface profiles on all four `index.html`,
the twelve components retokened (58 class replacements, no hardcoded
palette class left in `@shared-ui`), and the capture harness plus 63
baseline screenshots.

101 `shared-ui` tests (up from 55), 739 across the workspace, four clean
builds, lint clean on all nine projects, e2e green per project apart
from the two documented known-reds.

### Four things worth carrying forward

1. **`@theme static`, not `@theme`.** Tailwind v4 prunes theme variables
   whose utilities are unused, and a plain `@theme` emitted almost none
   of these into `:root` — confirmed by reading the built CSS. Runtime
   tenant theming works by *overriding* those properties, so they must
   exist in the cascade whether or not a utility references them today.
   Semantic roles are aliased with `var()`
   (`--color-primary: var(--color-brand-600)`), so overriding one brand
   step cascades through every role without the service knowing they
   exist.

2. **A real pre-existing accessibility defect, found by measuring rather
   than looking.** `border-slate-300` — the input border on every form in
   the workspace — measures **1.48:1** against white, against WCAG
   1.4.11's **3:1** for a control boundary. axe does not check non-text
   contrast on input borders, which is why it survived every prior
   accessibility pass. Fixed with a `--color-control` token at 4.76:1,
   kept distinct from decorative `--color-border`. The contrast table is
   now a unit test, so a future token edit cannot quietly drop below the
   floor.

3. **`deriveRamp` had two bugs that only measurement exposed.** Naive
   OKLCH→sRGB conversion clamps each channel independently, which shifts
   hue — the light steps drifted up to **0.37 radians** off the seed, so
   a tenant's "blue" tints came out visibly the wrong colour. Replaced
   with proper gamut mapping (hold hue and lightness, binary-search
   chroma down until it fits), the strategy CSS Color 4 specifies. And
   the ramp did not actually anchor on the seed despite a comment
   claiming it did; it now lands the supplied colour **exactly** on 600,
   which is what a tenant expects to see on their buttons.

4. **The contrast flip reached the token but not the text.** The
   retokening mapped every `text-white` to `text-on-solid`, which is
   fixed. But the *primary* fill is a tenant's own colour, so its text
   must use the flippable `text-on-primary`. With a pale brand
   (`#FFE066`) the token flipped to a dark ink correctly and the button
   still rendered **white on pale yellow** — the exact failure the flip
   exists to prevent. Caught only by applying a real tenant colour in a
   browser; every unit test passed throughout. Fixed by splitting the
   binding, with a regression test on both halves.

### Live verification

The whole chain was exercised against the running stack by pointing a
`WhiteLabelConfig.domain` at the backend's own host (local dev resolves
by the *backend's* `Host`, not the frontend's port — the documented
reverse-proxy gap): `GET /white-label/resolve/` → `branding()` →
`BrandThemeService.apply()` → the rendered button turning the tenant's
purple. **That path had never once worked in this codebase.** Also
confirmed: a pale brand flips the text to dark ink; `not-a-color`,
`javascript:alert(1)` and `''` all fall back to the default identity with
nothing reaching the stylesheet; and `super-admin-app` stays default blue
with zero white-label requests, as designed. The dev database was
restored afterwards.

Visual review: `docs/ui-review/14-design-system/iteration-1.md`. It
records two pre-existing defects re-confirmed against the baseline (the
390px passenger nav collapse and passenger table overflow, both owned by
spec 21) and one capture-list limitation to fix before the next
iteration — the client-admin captures land on a Business with no data, so
status pills and toggles were never actually photographed.

## Implementation note (Slice 2, done)

Built the ten new primitives — `ui-page-header`, `ui-filter-bar`,
`ui-action-menu`, `ui-drawer` (plus `DrawerService`), `ui-skeleton`,
`ui-tabs`, `ui-form-section`, `ui-toolbar`, `ui-density-toggle`,
`ui-export-button` — and eight new `IconName` entries for them. The
twelve-component uplift and class-binding rewrite this slice also
scheduled were folded into Slice 1 by decision, so they are not repeated
here.

211 `shared-ui` unit tests (up from 101), 916 across the workspace, four
clean builds, lint clean on all nine projects, axe clean throughout.
**No backend change.**

### Not a library-only slice, deliberately

The spec sliced this as `@shared-ui` alone, with the app rebuilds
following in slices 3–6. That would have shipped ten components with no
consumer, against this repo's own rule that a thin vertical slice beats a
complete layer nobody uses — and against its recorded experience that
components fail in ways unit tests do not see (`ui-select` renders no
error unless the parent binds `[invalid]`; `ui-toggle`'s description
reaches sighted users only; two validator screens carried a dead
`computed()` for months with green tests).

So seven of the ten were adopted on real screens in the same slice:

| Screen | Primitives | Notes |
|---|---|---|
| `client-admin-app` `vehicle-list` | page-header, action-menu, skeleton, density-toggle, drawer | Plus the toggle→pill conversion below |
| `client-admin-app` `vehicle-form` | page-header, form-section | Identity / Compliance |
| `super-admin-app` `business-list` | page-header, filter-bar | Replaces its hand-rolled submit-triggered search |

That was worth doing: **the two most valuable findings in this slice
came from those consumers, and neither was reachable from a unit test.**

Three ship with no consumer yet, each for a stated reason rather than
oversight: **`ui-toolbar`** needs a bulk selection, and no list has one
until slice 3; **`ui-tabs`** needs a sectioned detail screen, which is
slice 4; **`ui-export-button`** is spec 16's, which owns the export
endpoints it would call. All three are fully unit-tested, including
keyboard and ARIA.

`vehicle-list` overlaps slice 3's remit by one screen of thirty-five,
and `business-list` slice 6's by one of nine. Reviewed knowingly.

### The one behavioural change, on one screen

`vehicle-list`'s in-table `ui-toggle` is now a read-only `ui-status-pill`
plus an explicit **Activate/Deactivate** in the row's action menu, going
through `ui-confirm-dialog`. Same endpoint, same `fleet.manage`
permission, one deliberate step instead of one accidental one. A viewer
without `fleet.manage` sees the same status and no write actions at all,
which is tighter than the old screen: it rendered a pill *or* a switch
depending on permission, so the two paths could drift.

**The other five toggle screens (`route`, `stop`, `vehicle-type`,
`driver`, `schedule`) are untouched and belong to slice 3.** `route-list`
is still superseded by spec 19 as the spec records.

`vehicles.spec.ts` was updated in the same slice, never disabled: the
"Edit" link assertion became a menu item, and four tests were added
covering confirm-then-write, cancel-writes-nothing, the drawer's focus
return, and density persistence.

### Three things worth carrying forward

1. **CDK's menu emits `triggered` *before* it closes the menu**, so a
   handler that opens a dialog or drawer runs while focus is still on the
   menu item about to be destroyed — it captures that element as its
   focus-restoration target, and closing the overlay drops focus to
   `<body>`. A keyboard user is left at the top of the document after
   every row action. Fixed inside `ui-action-menu` (and `ui-export-button`,
   same CDK, same trap) by deferring the `selected` emission one
   macrotask, so no call site has to remember it and none can silently
   forget. **Found by e2e; every unit test passed throughout**, because
   focus restoration needs a real browser and a real overlay to go wrong
   in. There is now a unit test asserting the ordering contract directly
   — that `document.activeElement` is the trigger at the moment the
   output fires.

2. **The surface profiles were inert until this slice.** Slice 1 shipped
   six density tokens and set `data-surface` on all four apps' `<html>`;
   nothing read any of them, so the two profiles changed nothing. The
   primitives now do. The first consumer immediately mattered:
   `ui-action-menu` at this library's usual fixed `min-h-11` made every
   console table row ~68px against the ~40px a plain "Edit" link gave,
   roughly halving what fits on screen. Sized from `--ui-control-height`
   it is 36px on `console` and 44px on `consumer` — still clear of WCAG
   2.2 SC 2.5.8's 24px minimum. Then compact density turned out to move
   rows only 60px → 48px, since the control set the floor; making compact
   a **scoped override of `--ui-control-height`** rather than tighter
   padding got it to 38px. Three declarations instead of a compact
   variant per component, which is the whole point of a token layer.

3. **Two ARIA roles were deliberately *not* used**, because both carry
   keyboard contracts that projected content cannot honour, and a role
   that promises a navigation model which then does not work is worse for
   a screen-reader user than no role. `ui-toolbar` is a labelled `group`,
   not `role="toolbar"` (which owns roving arrow-key focus across
   controls this component has no handle on). `ui-tabs` *does* implement
   the full tabs pattern, and its keydown listener lives on the tabs
   themselves rather than the tablist — a listener on a container that can
   never hold focus only ever fires by accident of bubbling. `ng lint`'s
   `interactive-supports-focus` rule caught the second one.

Also recorded: `ui-action-menu` binds `cdkMenuItemDisabled`, never the
native `disabled` attribute, because CDK's key manager runs
`skipPredicate(() => false)` and deliberately lands on disabled items —
a natively disabled `<button>` is unfocusable, so `focus()` would no-op
and arrow navigation would stall there.

### Visual review

`docs/ui-review/14-design-system/iteration-2.md`, with `iteration-2/`
(as first built) and `iteration-3/` (after fixes) screenshot sets.

It also closes iteration-1's **F3**: the capture harness now selects a
populated Business, so status pills, action menus and populated rows are
actually photographed. Worth knowing on its own — **the first version of
that fix reproduced this repo's most-repeated bug**, resolving the
Business from a single `limit=100` fetch when this dev database holds 144
Businesses and the fixture sits past the first hundred. It found nothing,
returned quietly, and captured the wrong screens convincingly. It now
pages, and throws rather than falling back. The
"bounded fetch, `.find()` by id, silent fallback" family has a new home
in test tooling, which inherits no fix from `ListStore.findByIdPaged`.

Two findings are recorded and **not** fixed: the density toggle floating
alone without a toolbar to sit in (slice 3 designs that row once, for all
thirty-five lists), and client-admin tables overflowing at 390px with the
actions column off-screen — identical in the baseline, and the list
rebuild's problem rather than the token layer's.

### E2E state

Per project, never bare. `client-admin-app` 72 passed. `validator-app`
7/7. Three `client-admin-app`, one `customer-app` and two
`super-admin-app` specs fail on accumulated fixture state, **verified
against HEAD with this slice stashed — HEAD fails the same ones**, and
one more. Two are the known-reds already recorded in `CLAUDE.md`
(`bookings.spec.ts`'s trip dropdown, `trips.spec.ts`'s date filter); the
rest are exhausted or contended fixtures. `validator-app`'s one failure
resolved on re-running `seed_e2e_users`, as its own error message
suggests. The dev database is back to 144 leftover e2e Businesses and 203
vehicles under one fixture Business; `prune_e2e_test_data` still cannot
clear the KYB/KYC queues, per spec 11's self-check.

## Implementation note (Slice 3a, done)

Spec 14 scoped `client-admin-app`'s shell and all thirteen lists as one
slice. **Split into 3a and 3b by decision** — this repo has recorded
(Phase 4's frontend addendum) that a long continuous pass is where
defects slip past, and slice 2 was already substantial. 3a is the shell
plus the six network/fleet lists; **3b** is the transactional lists
(trips, bookings, fares, pay-as-you-go, payments, ledger, businesses)
plus `staff-list`.

717 backend tests (up from 690), 400 `client-admin-app` unit tests (up
from 349), 219 `shared-ui`, 44 `layout`, 980 across the workspace. Four
clean builds, lint clean on all nine projects, OpenAPI in sync, axe
clean.

### The backend change this needed, and why it was not optional

Spec 14 says "no backend change". That held for slices 1 and 2 and could
not hold here: **no client-admin list endpoint supported free-text
search.** Checked across every `*ListQuerySerializer` — routes, stops,
vehicle-types, vehicles, drivers and schedules accepted only
`?business=`, which the header switcher sets implicitly and no user ever
types. `?search=` existed on exactly one endpoint in the whole backend
(`/super-admin/businesses/`).

A `ui-filter-bar` with nothing behind it would have filtered only the
loaded page — the "bounded fetch, silent fallback" family this codebase
keeps re-finding, most recently in slice 2's own capture harness. So
`?search=` and `?is_active=` were added to those six endpoints, with
explicit sign-off, the same way Phase 5 frontend Slice C's two endpoints
were. Additive query params only: **no model change, no migration.**

`search` is validated in each app's shared query serializer but applied
by each *view*, which owns its own field list — the query's shape is
shared, what "search" means is not (a Route by name/code, a Stop by
name/address, a Vehicle by registration, a Driver by
name/phone/licence). Every clause narrows an already tenant-scoped
queryset, which is why no term a caller can type reaches another
Client's rows; there is a test per app asserting exactly that.

**A Schedule has no name of its own**, so it searches on `route__name`.
That is the useful thing to type, not a gap.

### Four things worth carrying forward

1. **DRF substitutes `False` for a *missing* `BooleanField` when the data
   looks like an HTML form — and a `QueryDict` always does.**
   `BooleanField.get_value` treats any mapping with `getlist` as form
   input, because an HTML form omits an unchecked checkbox entirely. So
   `?is_active=` was silently applied as `False` on every request that
   never mentioned it, filtering every list to inactive rows. Three
   previously-green `?business=` tests went empty the moment the param
   was added, which is the only reason it was caught immediately. Fixed
   by passing `params.dict()` rather than the `QueryDict`. **Any future
   boolean query param needs the same conversion**; the two other
   `NetworkListQuerySerializer` call sites were converted too, even the
   one that reads no boolean, because the trap is latent the moment
   anyone adds one.

2. **`ScheduleSerializer` now carries `route_name`.** `schedule-list`
   used to build a route-name map from the shared root `RouteStore`,
   which meant a schedule whose route sat outside that store's loaded
   page rendered as a raw UUID — and this slice would have made it worse,
   since `route-list` now writes search and status filters into that same
   store. Rather than work around it, the name comes down on the row.
   `select_related("route")` was already on the queryset, so it costs no
   query, and the screen lost an `ngOnInit` fetch and a whole store
   dependency. **A screen resolving another domain's label through a
   shared root store is a bug waiting for a second screen to filter it.**

3. **Sticky headers require a bounded scroll region — a consequence, not
   a preference.** `ui-table` wraps in `overflow-x-auto`, and CSS forces
   the other axis to `auto`, so the wrapper is already a scroll
   container: `position: sticky` on a `<th>` sticks to *the wrapper*, and
   with no height constraint the wrapper never scrolls vertically, so the
   header would compile, pass a class-list assertion and visibly do
   nothing. `stickyHeader` therefore comes with `maxHeight` (default
   `70vh`), off by default. Proven live rather than asserted: the region
   scrolled 400px and the header held at the same y.

4. **The accessible name was right and the visible affordance was
   missing** — the inverse of this codebase's usual failure. The shell's
   quick-create control shipped as `ui-action-menu`'s default icon-only
   "…" alone in a top bar: correctly labelled for a screen reader, and
   meaningless to everyone else. `ui-action-menu` gained `triggerLabel`,
   so the shell renders "New ⌄" and table rows stay icon-only. Found in
   the visual pass, by nothing else.

### What changed on screen

- **`NavShell` gained an optional top bar** carrying one quick-create
  menu. Additive and caller-supplied (`quickActions`), so
  `super-admin-app` and `validator-app` render no bar at all and are
  unaffected. Solves a real irritation: creating any record meant
  navigating to its own list screen first.
- **All six lists** (`routes`, `stops`, `vehicle-types`, `vehicles`,
  `drivers`, `schedules`) now have a page header, a filter bar with
  search + status and a chip per active filter, a row action menu,
  skeleton rows under `aria-busy`, sticky headers and shared density.
  `vehicle-list` — slice 2's proof consumer — moved to the shared
  `TableDensityStore` and gained the filter bar it could not have before
  the backend param existed.
- **The five remaining in-table toggles are gone**, replaced by a
  read-only `ui-status-pill` plus an explicit Activate/Deactivate in the
  row menu through `ui-confirm-dialog`. Same endpoint, same permission,
  one deliberate step. A viewer without the manage permission now sees
  the same status and no write actions at all — tighter than before,
  where each screen rendered a pill *or* a switch by permission and the
  two paths could drift. `route-list` is included: spec 14 says spec 19
  supersedes that screen and "whichever lands first wins", and this did.
- Two small shared pieces came out of the repetition rather than being
  designed up front: `TableDensityStore` (root-provided — density is a
  preference about reading tables, not about one screen) and
  `ListFilters` (a plain class, one per screen — a filter belongs to the
  screen you are looking at).

E2E was updated in the same slice, never disabled: `drivers`,
`schedules`, `stops`, `vehicle-types` and `fare-matrix` all clicked a row
"Edit"/"Fares" link that is now a menu item. `routes.spec.ts` gained
confirm-then-write, cancel-writes-nothing, a server-side search that
narrows and clears from its chip, and the quick-create menu.

### Visual review

`docs/ui-review/14-design-system/iteration-4.md`, with `iteration-4/`
(as built) and `iteration-5/` (after the fix) screenshot sets. Two
findings are recorded and not fixed: the filter bar's asymmetric labels
(revisit in 3b, when more controls join that row), and the 390px table
overflow — identical in the baseline, and the list rebuild's problem
rather than this slice's.

**One caution:** both the dev server and Django's `runserver` in this
environment were serving pre-slice code, and the first live search check
reported "no narrowing" against a backend that did not yet have the
parameter. Restart both before trusting a live check.

## Implementation note (Slice 3b, done)

The second half of slice 3, and **the end of `client-admin-app`'s list
rebuild**: `trips`, `bookings`, `fares`, `pay-as-you-go`, `payments`,
`ledger`, `businesses`, `staff`, plus `wallet-lookup` — the last screen
in the app still carrying a hand-written heading.

745 backend tests (up from 717), 418 `client-admin-app` unit tests (up
from 400), 222 `shared-ui`, 1001 across the workspace. Four clean
builds, lint clean on all nine projects, OpenAPI in sync, axe clean.
**`client-admin-app` e2e is 80/80** — green for the first time in this
arc.

### Three real defects closed, beyond the visual pass

1. **`GET /bookings/` and `GET /fare-journeys/` took no `?business=`.**
   Both screens listed every Business under the Client while the header
   switcher claimed one was active — the identical gap
   `TripListQuerySerializer` already records having had. Tenancy was
   never breached (`.objects` and RLS both hold at the Client boundary);
   the screens simply lied about their scope. A FareJourney has no
   business of its own, so its filter reaches through `trip__business`.

2. **`staff-list` wrote on a single interaction, twice per row** — a bare
   checkbox for access and a `<select>` that rewrote a colleague's
   *permissions* the moment it changed. Worse than any of the six
   toggles this spec named, and it named none of them. Both are now
   confirmed row-menu actions. The dialog also **refuses to confirm a
   role change that changes nothing**, and a member is offered neither
   action **on themselves** — the backend already rejects that, and
   offering an action that always fails is worse than omitting it.

3. **`trip-list` reassigned a vehicle or driver from an inline
   `<select>`** in a `max-w-40` cell, with no confirmation, while its
   own "Change status" already went through a dialog. Assignment is now
   one drawer with an explicit save, which also means both fields go in
   a single request — the old pair of selects each PATCHed the row's
   *current* vehicle **and** driver, so a second change fired before the
   first refetch landed raced against stale data (its e2e helper existed
   to work around exactly that).

**`booking-list`'s trip dropdown is gone**, and with it the known-red
recorded in `docs/self-check-2026-08-26-spec11.md`: it fetched
`limit=100` against ascending `Trip.Meta.ordering`, so a Business with
more than 100 trips was offered its *oldest* hundred. Search by route
name or passenger email replaces it — removing the bounded fetch rather
than re-bounding it — and `bookings.spec.ts` now passes.

### Backend

Additive query params only, no model change, no migration:
`?business=` on bookings and fare-journeys; `?search=` on bookings
(route name or passenger email), trips (route name), payments (PSP
reference), staff (email) and the Client-scoped businesses list. `staff`
and `businesses` had **no query params at all** before this, so each
gained its first query serializer.

Two serializers also gained nested names, for the same reason
`ScheduleSerializer.route_name` did in 3a: `FareRuleSerializer` and
`FareSegmentRuleSerializer` now carry `route_name` (and the segment one
`from_stop_name`/`to_stop_name`). `fare-list` was resolving all of them
through the shared root `RouteStore`/`StopStore`, which meant a fare
whose route or stop sat outside those stores' loaded page rendered as a
raw UUID — **and this slice would have made it worse**, since 3a taught
those same stores to carry search filters. Worse still, `fare-list`
called `getAll()` on both in `ngOnInit`, clobbering the routes and stops
list screens' own filter and pagination state.

**A screen resolving another domain's label through a shared root store
is a bug waiting for a second screen to filter it.** That is now three
occurrences (schedules, fares ×2), all fixed the same way.

### Two things worth carrying forward

1. **A control that looks like it worked is the failure mode this whole
   slice guards against, and I shipped one.** The pay-as-you-go screen
   rendered a labelled search box with a magnifying glass that ignored
   everything typed into it, because that endpoint has no free-text
   filter — my own template comment read "No search box" directly above
   the markup rendering one. Caught by the visual pass, by nothing else.
   `ui-filter-bar` gained `showSearch` (default `true`); a list with no
   server-side search sets it `false` and still gets its filters and
   chips.

2. **`ListFilters` now carries screen-specific filters**, not just
   search and `is_active`. Its `ExtraFilterConfig` takes a `chipValue`
   formatter, and that is load-bearing: a route or schedule filter sends
   a UUID, so a chip defaulting to the raw value would have put UUIDs on
   screen. `query()` declares `search`/`is_active` explicitly rather
   than leaving them to the index signature, so slice 3a's screens keep
   reading `query().search` (a bare `Record` forces `query()['search']`
   under TS4111).

Also fixed: `ui-status-pill` no longer wraps — a `rounded-full` pill
broken across two lines reads as a broken shape, visible on "Pending
payment" in the bookings status column. And 3a's recorded F2 (the search
label's alignment) is closed, since 3b puts up to four controls in one
bar, which is where it stopped being cosmetic.

### E2E

Updated in the same slice, never disabled: `businesses`, `staff`,
`trips` and `bookings` all changed shape. `trips.spec.ts`'s
`filterByRoute` helper now narrows with **search** rather than the Route
dropdown — the dropdown selects a route without bounding the *result*
list, so the row under test routinely landed past page 1 among dozens of
accumulated fixture routes. `e2e/fixture-lookup.ts` gained
`findBrowseRouteByName`, the same pager `findVehicleByRegistration`
already was, which is what actually fixed `bookings.spec.ts`.

The staff e2e picks whichever role the colleague does *not* currently
hold, because repeated local runs leave them on the last run's role and
the dialog correctly refuses a no-op change.

### Visual review

`docs/ui-review/14-design-system/iteration-6.md`, with `iteration-6/`
(as built) and `iteration-7/` (after fixes). Two findings recorded and
not fixed: the trips filter row wrapping below its search box, and the
390px table overflow — unchanged from the baseline and owned by the
mobile slice.

**Both of 3a's operational cautions bit again**: restart the dev server
*and* Django's `runserver` before trusting a live check, and run
`seed_e2e_users` between projects. Several apparent failures in this
slice were exhausted fixtures, not code.

## Implementation note (responsive tables, done)

Taken between slices 3b and 4 by decision, and scoped to **all three
table-bearing apps** rather than to `client-admin-app` alone — 15
`client-admin-app` tables, 5 `customer-app`, 4 `super-admin-app`;
`validator-app` has none. See
`docs/ui-review/14-design-system/iteration-8.md` for the visual pass.

### What it fixes, measured

Every data table in the workspace overflowed a 390px viewport. Recorded
three times without a fix (`iteration-2.md` F5, `iteration-4.md` F3,
`iteration-6.md` F5) and identical in the pre-rebuild baseline each
time, so this was long-standing rather than introduced by the rebuild.

The numbers, from the new guard, before the change: `routes` needed
**48px** of sideways scroll to reach a row's action menu, and
`customer-app`'s header forced the *whole page* to scroll by **206px**.
Both are zero now, at 390, 768 and 1200, on every screen the guard
covers.

### The mechanism, and what was rejected

**Not a card layout.** Stacking a `<table>` with `display: block` strips
table semantics from the accessibility tree in every browser, so the
card version would have meant re-declaring
`role="table"/"rowgroup"/"row"/"cell"` across two dozen templates to
stand still. Recorded here so it is not re-proposed.

What shipped is three visibility tiers on a table that stays a table:

- **Always**: the primary identifier, the status, and every column
  containing a control. *Never hide a column with a control in it* —
  that was the defect, and relocating it would not have been a fix.
- **`hidden md:table-cell`**: secondary data, whose values re-flow into
  a `md:hidden` sub-line under the primary cell. A narrow row loses
  columns, not information.
- **`hidden lg:table-cell`**: the long tail, on the widest console
  tables, reachable through the row's detail drawer.

`customer-app` and `super-admin-app` use two tiers only, because neither
has row drawers — everything hidden there compresses into the sub-line.
Four new detail drawers were built for `client-admin-app` lists that had
none (trips, businesses, ledger; `fares` has no row actions at all, so
its hidden columns re-flow instead).

`md` is Tailwind's 768px, matching `NavShell`'s existing
`COLLAPSE_BREAKPOINT`, so the console changes shape at one width.

### Three things worth carrying forward

**`ui-table` now owns horizontal cell padding, and consumers must not
set their own.** Three columns of `px-4` spend 96px on padding, which
behind the console's 64px collapsed icon rail was measurably the
difference between fitting and not — the 48px above was *entirely*
padding and unbreakable tokens. It is a deep selector with a media
query, and the 24 templates that used to declare `px-4` no longer do.
Vertical padding stays with the consumer: that is what the density
toggle changes.

**`overflow-wrap: anywhere` needs exempting for controls, and for short
fixed labels.** Without it a long generated route name or a booking UUID
sets a column's minimum width and no amount of column-hiding recovers
it. With it applied to the whole cell, the KYB queue's "Review" button
rendered as three stacked characters and the ledger's "Wallet top-up"
as three fragments. `button`/`a` are exempt in the component; a cell
holding a short enum label takes `whitespace-nowrap` itself.

**`ui-table`'s scroll container was keyboard-inaccessible**, and had
been since slice 3a gave it a bounded height. A scrollable region with
no focusable content inside cannot be scrolled from the keyboard at all
(WCAG 2.1.1). Axe caught it only intermittently — on a filtered trips
list whose rows had scrolled away — which is exactly how a real defect
hides behind a flake. The container is now a `tabindex="0"` region and
all 25 tables pass it a name; the role is conditional on that name,
because an unnamed `role="region"` is its own violation.

### Two guards, because the failure is silent

A `<th>` hidden without its matching `<td>` — or without the matching
skeleton `<td>` — renders every later value under the wrong heading.
Nothing throws.

1. **`expectColumnVisibilityParity`** (`@shared-ui`, `lib/testing/`),
   called from all 19 list specs across the three apps. Structural, so
   it needs no viewport: it compares the visibility classes on each
   `<th>` against every `<td>` at that index, skeleton rows included.
   Verified to actually fail by removing one class and watching two
   tests go red.
2. **`e2e/responsive-tables.ts`**, new, and running in the **ordinary
   suite** rather than behind `UI_REVIEW_DIR` — media queries only
   resolve at a real viewport, so this is the only place the result can
   be proven. Three widths × every table screen, asserting the page
   never scrolls horizontally, each table fits its container, every row
   shows as many cells as the header shows columns, and no row control
   sits outside the viewport.

**The guard is data-sensitive, and that is a feature.** `super-admin-app`'s
`business-list` passed it early in the session and failed later the same
day, once the dev database had accumulated more Businesses: three text
links in its actions cell (Paystack / Settlements / Seat hold), whose
labels are exempt from the break-anywhere rule, together set that
column's minimum width and squeezed Name to one character per line. A
single green run is not proof.

`selectBusinessByName` and `signIn` moved out of `ui-review-capture.ts`
into `e2e/session.ts`, shared by both harnesses rather than copied — the
paged Business lookup is exactly the kind of thing that gets re-derived
as a bounded fetch.

### Consequences elsewhere

**A hidden column's value is in the DOM twice**, so a Playwright
`getByText` scoped to a row is now ambiguous by design. Five assertions
across four specs became `expect(row).toContainText(...)`, which is what
they meant. Only one copy is ever displayed, so neither screen readers
nor the visible page see the duplication.

**`staff.spec.ts` is now serial.** Two of its tests write the same
colleague's active flag; in parallel they interleave and one finds an
"Activate" item where it expects "Deactivate". A flake, not a product
defect, and pre-existing — surfaced by running the full suite rather
than the specs this slice touched.

**`client-admin-app`'s e2e suite is load-sensitive at three workers**:
two different specs failed on two different runs and both passed
serially and at `--workers=2`. Dev-server compile latency, not
regressions.

### Not fixed, and named

- `trip-list`'s filter row still wraps below its search box
  (`iteration-6.md` F4) — a filter-bar layout question.
- `customer-app`'s bottom tab bar is still spec 21's. Only the header
  overflow was fixed here.
- `super-admin-app`'s `settlement-runs` table is not in the guard's
  screen list: its route needs a Business id, and the harness drives
  flat paths. Its columns are tiered like the rest.

### A mistake worth recording

`npx prettier --write` was run over `client-admin-app` to tidy the
edits. This repo has **no prettier dependency and no prettier config
beyond an HTML parser override**, so it applied its own defaults —
double quotes and an 80-column wrap — to 156 files. The source is
hand-authored in a prettier-*like* style that no setting reproduces
(seven print widths and three trailing-comma modes were probed against
37 known-clean files; the best match was 3/37).

Recovery: 36 files whose content was unchanged modulo formatting were
restored exactly from `HEAD`; the rest were reformatted to
`--single-quote --print-width 100 --trailing-comma es5`, which lands on
the arc's own style for all but a few lines. **Do not run a formatter
over this repo.** Format edits by hand.

## Implementation note (Slice 4, done)

`client-admin-app`'s forms, details and dialogs — the fourteen screens
the list slices never reached. Nine `*-form` screens plus `business-kyb`,
`kyc-status`, `white-label`, `seat-map` and `fare-matrix`. See
`docs/ui-review/14-design-system/iteration-12.md` for the visual pass.

Not the four auth screens (`login`, `register`, and the two
invite-accepts): they sit in `@layout`'s `AuthLayout` card shell rather
than the console, and they already had the best validation handling in
the app — they were three of the four `fieldError` copies that branched
on the actual error.

### Four defects, not a re-skin

**`fieldError` was copy-pasted seventeen times and mostly lied.** Twelve
copies returned the literal `'This field is required.'` for *any*
invalid control, whatever validator had failed — so a value that was
present but malformed, or too small, or rejected by the server, was
reported as missing. `white-label`'s went further and returned "Enter a
valid email address." for its *domain* field whenever that field was
invalid. All seventeen now delegate to one `fieldErrorMessage`
(`shared/form-errors.ts`) that reads the error which actually failed.

**Server field errors were flattened into one sentence.**
`extractFirstErrorMessage` takes DRF's `{field: ["message"]}` and returns
the *first* message for a page-level `ui-alert`, discarding both the
field it belonged to and every other field error in the response. A 400
naming two bad fields showed one sentence at the top and nothing on
either input. `applyServerErrors` distributes them onto their controls
and hands back only what could not be placed.

**Success was signalled three ways** — `ui-alert variant="success"` on
two screens, and a bare `<span>Saved.</span>` on two more, one in
`text-emerald-700` and one in `text-slate-500`, which does not read as
success at all. One treatment now.

**`seat-map` regenerated destructively on one click.** Its own paragraph
said "Regenerating replaces the vehicle type's entire current layout",
and the button fired immediately; the backend hard-deletes every
existing `Seat`, and `SeatReservation` points at `Seat`. It is behind
`ui-confirm-dialog` now, marked `danger` only when there is an existing
layout to destroy — the same one-mis-tap class this spec already called
its one behavioural change for the in-table write toggles, in a screen
that slice never reached.

`extractFirstErrorMessage` itself had been **privately re-pasted into
twelve components** against nine that imported the shared one, which is
exactly what its own docstring says not to do. Eleven now import it; the
twelfth (`wallet-lookup`) has a genuinely different variant and was left
alone.

### Five things worth carrying forward

**`setErrors` is not durable, and that is not obvious.** Angular calls
`updateValueAndValidity` whenever a control is bound to a
`formControlName` directive, and that *replaces* `errors` with whatever
the validators return. A server message set on a control that is not
currently rendered — or one inside an `@if` that opens later, like a
per-segment fare's stop pickers — vanished the moment the field
appeared. Found by a white-label test whose form happened to render for
the first time after the submit. The message now lives in a `WeakMap`
keyed by control, alongside a snapshot of the value the server rejected;
that snapshot is also what clears it, with no subscription to leak.

**A form section's title must not be, or contain, the label of a field
inside it.** `ui-form-section` renders a real `<section aria-labelledby>`,
so "Domain" wrapping a field labelled "Domain" gives a screen-reader
user the same word twice and makes the control ambiguous — three
sections collided this way, and `getByLabel` found two elements for each.

**A hidden value carrier needs naming, once.** All eight record forms
hold `business` as a control with no field on screen: it comes from the
header switcher and exists only to carry the value into the POST body.
`POST /routes/` can still reject it — "This Business must be
KYB-approved" is a real response — and placed on that control the
message would be invisible. `HIDDEN_VALUE_CARRIERS` is a default rather
than eight identical arguments, because forgetting it on a ninth form
would swallow the message silently.

**`ui-alert`'s role now follows its variant.** It was hard-coded to
`alert`, an *assertive* live region that interrupts a screen reader
mid-sentence. Right for a failure; wrong for "Saved.", and wrong again
for the static guidance several screens render through it. `success` and
`warning` are `status`. Two `validator-app` specs querying
`getByRole('alert')` for a success outcome had to move to `status` —
the intended consequence, not a workaround.

**`ui-text-field` gained the `hint` input `ui-select` has had since
spec 12.** Half the console's forms had nowhere to put a format note
except a loose `<p>`, which reaches sighted users only.

### Not adopted: `ngx-toastr`

The roadmap listed it as an adoption "landing in the first spec with a
real consumer". This slice was that consumer and the decision went the
other way — inline only, using the `ui-alert variant="success"` that
already existed. A toast disappears and may never reach a screen-reader
user; the roadmap's own rule that a toasted failure must *also* render
inline meant the inline path had to exist regardless. The roadmap entry
is updated rather than left to send the next reader looking for a
dependency that was deliberately not added.

### Verification

1091 frontend unit tests, up from 1056 — client-admin 475 (was 446),
shared-ui 247 (was 241). Four clean builds, lint clean on all nine projects.
No backend change, so no migration and no OpenAPI regeneration.

Every form's spec now asserts on **rendered** output rather than on the
request that did not happen: spec 11's self-check recorded that
`ui-text-field`/`ui-select` show nothing unless the parent binds both
`[invalid]` and `[errorMessage]`, and that a form binding neither fails
silently — which is exactly what let that defect ship. Two forms also
feed a 400 carrying two field errors and assert both land on their own
controls.

`client-admin-app` e2e is 83/83. `customer-app` 13/14 (the seat-fixture
known-red, unchanged), `super-admin-app` 19/19, `validator-app` 6/7 —
that one is a `FareJourney` left open on this dev database by an aborted
run, which the one-open-journey-per-passenger index then rejects every
later board tap against. It cannot be pruned: `TapEvent.journey` is
`PROTECT`-ed, the same shape `prune_e2e_test_data` already cannot clear
for KYB documents.

## Implementation note (Slice 5, done)

`customer-app`, the consumer rebuild — all eleven screens plus the app
shell. **1136 frontend unit tests** (up from 1091), four clean builds,
lint clean on all nine projects, axe clean throughout. **No backend
change**: no migration, no OpenAPI regeneration.

Decisions taken with the user before building: include `customer-app`'s
login (the other three apps' auth screens stay for slice 6); promote
`form-errors.ts` to `@shared-ui` rather than copy it; primitives read
`--ui-text-body` but `ui-table` deliberately does not; and fix four
named defects rather than only re-skinning.

### The consumer surface profile was inert, and that is a real defect

`theme.css` has defined two densities since slice 1, and every app has
declared one on `<html>`. **Nothing read `--ui-text-body`** — one file
referenced it (`skeleton.ts`), while `button`, `text-field`, `select`,
`alert`, `empty-state` and `paginator` all hard-coded `text-sm`. The
phone app rendered at console density.

That is not only aesthetic: **iOS Safari zooms the page whenever a
focused input's font-size is below 16px**, which every text field and
select in the passenger app triggered. It is the most common mobile form
defect there is, and the token to fix it had been sitting unread.

Those six primitives now take their size from the token —
`0.875rem` in the three consoles, so **their rendering does not change
at all**, and `1rem` in `customer-app`. `lib/theme/surface-profile.spec.ts`
asserts both directions rather than assuming the consoles are safe.

**`ui-table` deliberately keeps `text-sm`**, with a comment saying why: a
data grid is the one place density beats size, and the responsive-tables
slice measured and guarded these tables' fit at 390px *at 14px*. Growing
every cell would reopen exactly that. `customer-app`'s four sub-lines
moved from `text-xs` to `text-sm` in compensation, so nothing in the
passenger app renders below 14px.

### `form-errors` moved to `@shared-ui`, minus one app's opinion

Slice 4 wrote it for `client-admin-app`; `customer-app` needed it and
path aliases only cross library boundaries. The move is otherwise
mechanical, with one real edit: `HIDDEN_VALUE_CARRIERS = ['business']`
is that console's own concept, and a library must not ship one app's
field name as a default.

It did not simply become an argument, because the original module argues
against that correctly — nine forms depend on it, and passing it nine
times is how a tenth silently swallows a message.
`client-admin-app/src/app/shared/form-errors.ts` is now a thin wrapper
that bakes it in, so **no call site changed**, and its own spec proves
the default survived the move.

### White-labelling still did not white-label anything

Spec 14's second founding finding was that `logo`, `name`,
`primary_color` and `secondary_color` were read only by the form that
edits them. Slice 1 closed the colour half via `BrandThemeService` —
but **`logo` and `name` were still read by nothing, in any app**,
confirmed by grep. `app-brand-mark` is their first consumer: the
operator's logo, else their name, else ours, on the login card and in
the header. Its `alt` names the operator rather than saying "logo",
because a screen-reader user needs to know whose app this is.

### Four defects fixed, plus a fifth the screenshots found

1. **Paying moved money on one tap.** "Pay now" went straight to
   Paystack, with the wallet option a bare `<input type="checkbox">`
   loose in a read table cell beside up to three buttons. It is a
   confirmation dialog now, carrying the amount, the split, and a button
   naming the outcome — *Pay from wallet* when the balance covers it,
   *Continue to Paystack* otherwise, because a passenger sent to a bank
   page unannounced abandons the payment. The secondary actions moved
   into `ui-action-menu`; the cell holds at most two controls.
2. **The wallet top-up accepted anything.** A bare string signal gated
   on "not empty" sent `abc`, `-5`, `0` and `12.345` to `POST /payments/`,
   and the field offered a phone a QWERTY keyboard for a sum of money.
   Now a validated reactive control with `inputmode="decimal"` (**not**
   `type="number"` — spinners, wheel capture and locale parsing all make
   that a poor money input), and a new `ui-text-field` `inputMode` input.
3. **`my-credentials` had no paginator** despite a 25-row store, the
   only list in the app missing one.
4. **`trip-search` said "Choose seats" on open-seating trips**, where
   the passenger picks a count. This screen cannot know which the next
   one will ask for — quick book is decided by the availability envelope,
   not by anything on `Trip` — so the button says **Continue**, with a
   per-row `ariaLabel` naming the departure so a dozen identical buttons
   are distinguishable. `open-seating.spec.ts` had been clicking the
   wrong word for months.
5. **The seat map rendered the bus backwards** — found only by reading
   the screenshot. See below.

### Four things worth carrying forward

1. **`Seat.Meta.ordering = ["-created_at"]` reaches further than spec 10
   fixed.** `apps.seating.services.get_availability` has no `order_by`,
   so it serves the seat map newest-first: `iteration-15` photographed a
   bus reading 3B, 3A, 2B, 2A, 1B, 1A. Spec 10 recorded this exact trap
   and fixed it for quick-book *allocation*; nobody checked the map a
   passenger looks at. `seat-picker`'s row/column path sorts itself and
   was fine — only its no-geometry fallback trusted the order. Fixed
   frontend-side (this slice makes no backend change) with an
   `Intl.Collator({numeric: true})`, so 10A sorts after 9A rather than
   after 1A. **The missing `order_by` is still the root cause and is
   worth correcting at the source**, not least because
   `splitAtAisleGaps`' docstring states a precondition — "already sorted
   by column" — that the backend does not guarantee.
2. **A capture harness that cannot see a blank page will photograph
   one.** Slice 4 wrote `kyc-status` out as three entirely blank images
   across two iterations while reporting success. Every capture now
   asserts a level-1 heading before writing the file — checked safe
   across all four apps' capture lists first.
3. **`CaptureConfig` takes `flows` now**, for screens a URL cannot
   reach. `seat-picker` and `booking-confirm` are half the booking flow
   and had never been photographed, because both read their subject from
   router state and bounce to `/search` without it. Slice 4 solved the
   same problem with a throwaway spec it then deleted.
4. **A status pill that re-flows into a sub-line renders twice.** Moving
   `my-bookings`' Status column below `md` made
   `row.getByText('Pending payment')` a strict-mode violation — the same
   duplication the responsive-tables slice recorded. `toContainText` on
   the row is the remedy, and it was already written down.

### Verification

`customer-app` e2e **14/14** — up from the 13/14 this spec recorded at
slice 4, because that known-red turned out to be a bounded-fetch bug and
is fixed: `booking.spec.ts` resolved its route from one unbounded
`GET /routes/browse/` plus `.find()`, and with 43 routes against a page
size of 25 the fixture had fallen off page 1. `e2e/fixture-lookup.ts`
already exported `findBrowseRouteByName` for that exact symptom and this
call site had never adopted it.

`client-admin-app` is **83/83 with `--workers=1`** and rotates a single
different failure under parallel workers — three consecutive full runs
failed three different specs, each passing in isolation and on repeat.
Contention on the shared seeded Client, not a regression. One genuine
staleness was found and fixed there: `kyc-status.spec.ts` still asserted
the raw enum `proof_of_address`, which **slice 4's own F5 fix had
replaced with the label**.

`validator-app` **7/7**, up from 6/7: two `FareJourney` rows left open by
aborted runs (one dating to 2026-08-16 — this spec's own slice-4
diagnosis, still open) were closed, which is what an alight tap does and
what deletion cannot do, since `TapEvent.journey` is `PROTECT`ed.

`super-admin-app` rotates one failure for a **structural** reason worth
naming: the KYB queue has grown to **79 rows and the fixture is row 79**,
so `openQueueAtSeededRow` pages the whole way to it and any sibling test
that approves it removes it for the rest. CLAUDE.md already records that
`prune_e2e_test_data` cannot clear these queues; this measures it — 36
rows when written, 79 now. Likewise `validate-ticket.spec.ts` consumes a
finite supply of unboarded fixture tickets that nothing replenishes (all
16 were boarded), so it degrades to permanently-red until reseeded. Both
are seeding problems, named for slice 6 rather than papered over.

Visual review: `docs/ui-review/14-design-system/iteration-15.md`,
captures in `iteration-15/` and `iteration-16/`.

## Implementation note (Slice 6a, done)

`@layout` and `super-admin-app`. **1179 frontend unit tests** (up from
1136), four clean builds, lint clean on all nine projects, axe clean.
**All four e2e projects green** — `super-admin-app` 19/19,
`client-admin-app` 83/83, `customer-app` 14/14, `validator-app` 7/7.
**No backend change.**

### Why slice 6 was split

The roadmap said slice 6 was "`super-admin-app` + `validator-app` and
the three remaining auth screens". Surveying it before planning found
that understates the work three ways, and the user split it into 6a and
6b on that basis:

1. **`@layout` had never been in any slice's scope** and still held 50
   `slate-*` literals. `NavShell` is the chrome on every
   `client-admin-app` *and* `super-admin-app` screen; `NotificationBell`
   renders in all four apps. Slice 3a added a quick-actions top bar to
   `NavShell` without tokenising what was already there.
2. **There are six auth screens, not three** — the roadmap counted
   logins and missed `register` and the two invite-accepts.
3. Two `client-admin-app` screens (`staff-invite`, `file-upload-field`)
   were never in slice 4's list.

6b carries the auth screens, `validator-app`, and those two leftovers.

### `@shared-ui` had no textarea, radio or checkbox

Seven screens hand-rolled them, and **three still carried
`border border-slate-300`** — the input border slice 1 measured at
**1.48:1** against WCAG 1.4.11's 3:1 and replaced everywhere else with
`--color-control` at 4.76:1. `theme.css` already records why that
survived: *"axe does not check non-text contrast on input borders, so it
never surfaced."*

The border is the measurable half. The rest is that a hand-rolled
control has no label association beyond what the caller remembers to
write, no `aria-describedby`, and **no way to render an error at all** —
so a server error on a textarea or a boolean had nowhere to go.

- **`ui-textarea`** — `kyc-queue`, `kyb-queue`, `my-bookings`.
- **`ui-radio-group`** — `kyc-queue`, `kyb-queue`, `trip-list`. Native
  inputs sharing a `name`, so the browser's own arrow-key selection and
  single-tab-stop behaviour come for free. Reimplementing that on styled
  buttons is the trap `ui-toolbar` records for declining
  `role="toolbar"` — and `validator-app`'s board/alight control is a
  live instance of it, a `role="radiogroup"` div wrapping two
  `ui-button`s with `aria-pressed`, which announces as a radio group and
  behaves as two toggles. That one is 6b's.
- **`ui-checkbox`** — one real consumer, `paystack-config`. See below.

### Two anticipated consumers that turned out not to exist

The plan named three consumers for `ui-checkbox` and two were wrong.
`staff-list`'s bare checkbox had **already** been replaced by a
confirm-dialog action in an earlier slice — only a comment mentioning it
survived, which is what the grep matched. `schedule-form`'s is a *group*
of seven weekday boxes: a different component, already correctly built
with a `fieldset`, `legend`, `min-h-11` rows and `border-control`, and
with nothing wrong with it. Building a group primitive for one
already-correct consumer would be gold-plating.

Recorded rather than resolved by inventing a use for it.

### Four defects closed, beyond the re-skin

1. **super-admin's `home` was the Phase 0 placeholder.** It printed
   `Client: —`, `Platform staff: true` and a green box reading "You have
   super-admin-app access." — telling a platform-staff user that they
   are platform staff, on the landing page they see every day. Now a
   heading plus cards to the four destinations the nav already carries.
   No new endpoint.
2. **`paystack-config` failed silently.** Three of its four fields bound
   **neither** `invalid` nor `errorMessage`, so an empty submit refused
   to send and said nothing — spec 11's recorded trap in its purest
   form, whose whole point is that a test asserting only "no request
   happened" passes against it. The fourth hardcoded "This field is
   required." `settlement-runs` had the same gap on both its dates.
3. **An unread notification was a `bg-slate-50` tint and nothing else** —
   colour as the only status indicator, against this repo's own bar, and
   a tint faint enough to barely be one. A screen-reader user got no
   signal at all. It has a dot and an `sr-only` "Unread." now.
4. **The nav was Title Case against sentence-case headings** — four of
   five items, exactly the defect slice 4 fixed in client-admin as F4.

### Three things worth carrying forward

1. **`overflow-wrap: anywhere` is for data, not for headings.**
   `ui-table` applied it to `th` and `td` alike, and the KYB queue
   rendered "VERTIC AL", "DIRECTO RS" and "DOCUMEN TS" at 1200px. Now
   `anywhere` on `td`, `break-word` on `th`. That rule had already
   needed one carve-out (`:is(button, a)`, after "Review" rendered as
   three stacked characters) and this is the second; both come from
   aiming at long values and hitting the whole table.
2. **A table with more than about five columns needs all three tiers.**
   Fixing the headings exposed that the KYB queue put seven columns at
   `md`, so crossing 768px showed every one at once: cells wrapped to
   five lines and Review was pushed off the edge. `ui-table`'s
   convention already names a `lg` long tail; this screen used only two
   tiers. **The responsive-tables guard passed throughout** — it
   measures fit, overflow and column parity, all of which were correct.
   It cannot measure legibility, which is what reading the screenshots
   is for.
3. **`ui-page-header`'s `breadcrumb` slot existed since slice 2 and had
   no consumer.** All three business-scoped screens hand-rolled a
   `← Businesses` link above their own `<h1>`. Worth grepping for an
   unused slot before adding a fourth hand-rolled one.

### Not fixed, and named

- **`NavShell` keeps a 64px rail at 390px**, so a phone-width console
  gives its content 326px. Unlike `customer-app`, 390px is not this
  app's authoritative viewport and its tables do fit and scroll
  correctly; an off-canvas drawer is a real design change that would
  affect `client-admin-app` identically.
- **`seat_hold_minutes` has only `Validators.required`**, so `0`, `-5`
  and `abc` all reach the API — the same shape as the wallet top-up
  slice 5 fixed. Adding validation is behaviour, and this slice changes
  none.
- **The email in a 20px heading**, now in two apps — see slice 5's own
  F4. One decision would settle both.

Visual review: `docs/ui-review/14-design-system/iteration-17.md`,
captures in `iteration-17/` through `iteration-19/`.

## Implementation note (Slice 6b, done) — **this spec is complete**

`validator-app`, the six auth screens, and `client-admin-app`'s two
leftovers. **1188 frontend unit tests** (up from 1179), four clean
builds, lint clean on all nine projects, axe clean, and **all four e2e
projects green in a single pass** — `client-admin-app` 83/83,
`super-admin-app` 19/19, `customer-app` 14/14, `validator-app` 7/7.
**No backend change.**

**There are no `slate-*` colour literals left in the workspace.** The
only remaining matches are comments in four files explaining what was
replaced and why. Spec 14's founding finding #1 — "there is no design
token layer… styling is raw utility classes across 58 templates" — is
closed.

### `validator-app` declared the wrong surface profile

This spec says its "targets are sized for the consumer profile even
though its palette is the console one — a conductor is not reading a
data table". Its `index.html` said `console`. The contradiction was
invisible until slice 5 made the profile actually reach the controls,
and it is now `consumer`: 16px body type and 44px-plus targets on the
one app the spec singles out for them.

**That flip broke the app's own header**, which is worth stating
plainly rather than as an aside: a mark, a wordmark, two nav links, a
bell and a Sign out button on one fixed row only just fitted 390px at
console density, and stopped fitting once everything grew. Fixed the way
`customer-app`'s header already was — the nav takes its own full-width
row below `sm` — plus `whitespace-nowrap`, because "Record tap" was
breaking mid-phrase inside its own pill.

### The board/alight switch announced as something it was not

A `<div role="radiogroup">` wrapping two `ui-button`s with
`aria-pressed`: a radio group to a screen reader, two independent toggle
buttons in fact, with no arrow-key selection and two tab stops. Exactly
the mismatch `ui-toolbar`'s docstring warns about, and the live instance
slice 6a's `ui-radio-group` docstring already named.

It is now `ui-radio-group`'s new **`segmented`** variant: native radios
sharing a name, `sr-only`, with their labels styled as the two large
adjacent targets that were there before. A skin, not a second
implementation — which is what lets the browser keep the whole keyboard
contract.

### Two helpers promoted, and why each was overdue

- **`app-brand-mark` → `@layout`**, which already owns `AuthLayout` and
  already depends on `@auth`. `client-admin-app`'s and
  `validator-app`'s logins now carry the operator's mark;
  `super-admin-app` deliberately does not, since it spans every Client.
  Validator keeps a "Validator" wordmark beside the logo — a conductor
  must be able to tell this app from the passenger one, and a tenant
  logo alone cannot say which it is.
- **`formatMoney` → `@shared-ui`.** `customer-app` held the original,
  `client-admin-app`'s `booking-list` kept a private copy **whose
  comment said it was local *because* the helper was not in a shared
  library**, and `validator-app` interpolated the two values by hand in
  the opposite order. The same money read "NGN 300.00" on three screens
  and "300.00 NGN" on a fourth. `multiplyDecimal` stays in
  `customer-app` — it is seat-fare arithmetic, not formatting.

### Three defects closed, beyond the re-skin

1. **An expired invite link showed Django's internal 404.** Both
   invite-accept screens passed the server's `detail` straight through,
   so a stale link rendered *"No StaffInvitation matches the given
   query."* — `get_object_or_404`'s default, naming the model class, to
   a person who is not yet a user of this system. The worst instance of
   the raw-value family this spec has found, because it is the only one
   shown to someone outside the organisation.
2. **`file-upload-field` was the last `border-slate-300`** — the 1.48:1
   input border against WCAG 1.4.11's 3:1 — and its error `<p>` was
   rendered but never referenced by the input, so a screen reader
   announced the field as valid while a message sat visibly beneath it.
   Its docstring also claimed two consumers; it has one.
3. **`staff-invite` never got slice 4's console-form treatment** — it
   was not in that slice's list — so it still had a bare `<h1>`, no
   `ui-form-section`, and two hand-written per-field error methods over
   a private `fieldErrors` helper.

### Three things worth carrying forward

1. **A form-level error is invisible to `fieldErrorMessage`.** Three
   password-confirmation forms carry `passwordMismatch` on the *group*,
   and the helper reads control-level errors only — so migrating them
   could have dropped that message silently while every test still
   passed. Each now checks it explicitly, after the control errors, so
   an empty confirmation still reads as missing rather than mismatched.
   **Any future migration of a form with a cross-field validator needs
   the same check.**
2. **A `sr-only` input cannot be clicked at the input.** Playwright's
   `.check()` on the segmented radio times out: the label covering it
   intercepts the pointer. That is correct — a user clicks the label —
   so the spec clicks the label. `sr-only` and not `hidden` is what
   keeps the input focusable and arrow-selectable, and is the whole
   reason the variant works.
3. **A shared component's new dependency reaches its consumers' specs.**
   Adding the brand mark to four screens broke seven unrelated tests
   with `No provider found for API_CLIENT`, because
   `WhiteLabelResolverService` injects it transitively. The same stub
   gap slice 5 hit on `customer-app`'s login, hit again — worth
   expecting whenever a component gains a service.

### Not fixed, and named

- **`business-kyb`'s two hand-rolled file inputs.** They already use
  `border-control`, so nothing is broken; consolidating them onto
  `file-upload-field` is tidying a slice-4 screen.
- **`NavShell`'s 64px rail at 390px** — 6a recorded it; it needs an
  off-canvas decision affecting `client-admin-app` equally.
- **`seat_hold_minutes` validation** and **the email-in-a-heading
  fallback** — both recorded in 6a.
- **The dev database's three e2e-fixture problems**, all recorded
  before and all still true: a `FareJourney` left open by a failed run
  blocks the next board tap and cannot be pruned; `validate-ticket.spec.ts`
  consumes a finite supply of unboarded tickets; and the KYB queue is now
  **82 rows with the fixture at row 82**, up from 79 at slice 6a and 36
  when first recorded. All three are seeding problems, not screen ones.

Visual review: `docs/ui-review/14-design-system/iteration-20.md`,
captures in `iteration-20/` through `iteration-22/`.
