# Self-check

Run at the end of every module and every phase. When told "run the self-check," this is what it means.

## Standard of proof

The target is ~95% confidence that the work is functioning and compliant. That does not mean asserting 95% confidence. It means:

- **Every claim is backed by an artifact that can be reproduced** — a command and its actual output, a test result, a Playwright trace, a screenshot, a file path and line number. Never a claim from memory of what was written.
- **Anything that could not be verified is listed explicitly** as unverified, with the reason.
- **The residual 5% is named.** State precisely what could still be broken and why the checks would not catch it.

A report with no findings is not a pass — it signals the checks did not look hard enough. If a check genuinely finds nothing in an area, say what was tried and why that is trustworthy.

Never mark anything green that has not been executed. If a check cannot run because the module does not exist yet, say "not applicable at this phase" — do not skip it silently, and never fabricate a result.

## 10.1 Convention compliance

Run these and paste the real output. Each should return nothing; every hit is a violation, listed with file and line.

```bash
# Angular v20 rules
grep -rn "standalone: true" projects/ --include=*.ts
grep -rn "@HostBinding\|@HostListener" projects/ --include=*.ts
grep -rn "\*ngIf\|\*ngFor\|\*ngSwitch" projects/ --include=*.html
grep -rn "ngClass\|ngStyle" projects/ --include=*.html
grep -rn "@Input()\|@Output()" projects/ --include=*.ts
grep -rn "\.mutate(" projects/ --include=*.ts

# File naming: no .component suffix
find projects/ -name "*.component.ts" -not -path "*/node_modules/*"

# Path aliases, not deep relative imports into libs
grep -rn "from '\.\./\.\./\.\./\.\./" projects/ --include=*.ts

# Type safety
grep -rn ": any\b\|<any>\|as any" projects/ --include=*.ts

# No NgRx
grep -rn "@ngrx" projects/ package.json

# Hardcoded API URLs
grep -rn "http://\|https://" projects/ --include=*.ts | grep -v environment | grep -v spec
```

Then verify by inspection, citing files: every component uses `ChangeDetectionStrategy.OnPush`; every shared library exports through `public-api.ts` and is imported via `@shared` / `@auth` / `@layout`; signal stores live at `shared/data/store/<domain>.store.ts` and follow the `getAll()` / `updateQuery()` / `changePage()` shape; reactive forms only, no `ngModel`; Tailwind used first, with every Angular Material import justified.

Backend: `ruff` and `mypy` pass clean — paste output. Money is `Decimal` everywhere with an adjacent currency field, no float touches money, all stored datetimes are UTC.

## 10.2 Backend verification

- Run the full `pytest` suite. Paste the summary line and coverage.
- Confirm these tests exist and pass, by name. A missing one is a finding, not an omission:
  - Cross-client isolation — a user of Client A cannot read, list, update or delete any Client B record, tested per endpoint, not just per model.
  - Concurrent seat booking — two parallel requests for the same seat on the same segment; exactly one succeeds.
  - Segment-aware availability — a seat booked A→B is still offered for C→D on the same trip.
  - Ledger invariant — debits equal credits for every transaction; derived balances match expected.
  - Payment idempotency — a replayed idempotency key does not double-charge or double-credit.
  - Webhook replay — a duplicate PSP webhook produces no second ledger movement.
  - Seat-hold expiry — an expired hold releases inventory.
- Confirm the OpenAPI spec regenerates with no diff; paste the drift-check result.
- List every endpoint with no test.

## 10.3 Playwright end-to-end verification

Run against a **real running stack** — backend, database, and the relevant Angular app — not mocks. Cover whichever paths exist at this phase:

1. Client self-registration → business added → KYC/KYB uploaded → super-admin approves → client signs in.
2. Super-admin invites a client → invited client completes onboarding.
3. Client-admin creates a route with ordered stops, a schedule, a vehicle type with seat layout, a vehicle, and a fare rule.
4. Passenger registers on a white-labeled subdomain, searches a trip, receives an auto-assigned seat, opens the seat map, changes seat, completes a booking.
5. Group booking with more than one passenger, and a concession fare applied.
6. Payment by wallet, by card, and by a combined wallet+card intent.
7. Ticket issued with a scannable QR — decode it in the test and assert the payload verifies against the signing key.
8. Refund and cancellation honouring the client's configured policy.
9. Trip cancellation triggering refunds and notifications.

Capture a trace and a screenshot at each assertion point, and state where the artifacts are. Also run the negative paths: expired seat hold, declined card, insufficient wallet balance, duplicate ticket validation, and a passenger of Client A attempting to reach Client B's data.

## 10.4 Accessibility

Run AXE via Playwright on every page reachable in the flows above. Report violations by page with severity. WCAG AA is a hard requirement — list every failure, do not summarise as "mostly clean." Verify keyboard-only completion of the booking flow and visible focus states.

## 10.5 Security and correctness sweep

- Confirm tenancy filtering is enforced structurally (base manager / middleware) and find any queryset bypassing it. Paste what was searched for.
- Confirm no secrets are committed and settings read from environment.
- Confirm rate limiting is active on auth, seat-hold and booking endpoints, and demonstrate it triggering.
- Confirm audit records are written for privileged and money-moving actions, and are append-only.
- Assert query counts on every list endpoint to catch N+1.
- Confirm every migration so far is additive and reversible; flag any destructive one.

## 10.6 Visual iteration loop

Static checks and passing tests do not tell whether the interface actually works. For every module with UI, run this loop until the exit criteria in 10.6.4 are met.

### 10.6.1 Capture

With the real stack running and demo data seeded, use Playwright to screenshot **every route the module adds**, in **every state**: loading, empty, populated, error, validation-error, success, and permission-denied. Capture full-page plus any dialog, drawer, menu or seat map.

Capture at 390px, 768px and 1440px. The **authoritative** viewport is 390px for the passenger app and 1440px for client-admin and super-admin — defects at the authoritative width block the module; defects at the others are findings but not blockers unless they break usability.

Save to `docs/ui-review/<module>/iteration-<n>/`.

**Then actually open and look at every screenshot.** Read the image files. Do not reason about what the markup should render — judge what it did render. If an image has not been viewed, it cannot be reported on.

### 10.6.2 Analyse

Judge each screenshot against the Integra design language established in `shared-ui` (spacing scale, type scale, colour usage, density, table and form patterns). A screen should look like a sibling of the existing shared components — table, paginator, button, status-pill, empty-state, metric-card, input, select, date-input, money-input — not a stranger.

Look specifically for: content clipped or overflowing; horizontal scroll; overlapping or colliding elements; broken or inconsistent alignment; inconsistent spacing; unreadable contrast; text truncated without an affordance; tables unusable at the captured width; controls too small to tap on mobile (minimum 44×44px); missing loading and empty states; unstyled or default-browser controls; layout shift between states; focus states invisible; error messages unattached to their field.

Stress the content, do not judge on tidy demo data: very long passenger and route names, large fare amounts, many stops, fifty-row tables, zero-row tables, and the longest concession label.

Record every defect in a table with screen, viewport, state, severity, and the screenshot it came from.

### 10.6.3 Fix, then re-verify

May be fixed, without asking first: CSS and Tailwind classes, template structure, responsive behaviour, component composition, accessibility attributes, focus management, loading and empty states, and UI copy.

Must **not** be silently fixed — report and wait instead: data model or migration changes, API contract changes, anything touching money, the ledger, payments or refunds, and anything touching auth, permissions or tenancy. If a UI defect can only be fixed by changing one of those, stop and report it.

After each round of fixes, re-capture the affected screens, re-run the unit suite and the affected Playwright specs, and confirm nothing regressed. A fix that breaks a test is not a fix.

Write `docs/ui-review/<module>/iteration-<n>.md` each round: the defects found, what changed, before and after screenshots, and what is still outstanding.

### 10.6.4 Loop control and exit

Repeat capture → analyse → fix until **all** of the following hold:

- Zero AXE violations at WCAG AA on every screen.
- Zero browser console errors or warnings.
- No clipping, overflow, collision or broken alignment at any captured viewport.
- Every state renders correctly, including with stressed content.
- Every interactive element has a visible focus state; mobile targets are at least 44×44px.
- The booking flow is completable by keyboard alone.
- The module is visually consistent with the Integra design language.
- Unit tests, affected e2e specs, lint and type-check all pass.
- The final iteration introduced no regression.

Hard limits, so this does not run forever:

- **Maximum five iterations.** If the criteria are not met by then, stop and report the remaining defects with an assessment of why they resisted fixing.
- **If the same defect survives two consecutive fix attempts, stop immediately** and escalate it. Do not keep trying variations.
- If a fix would require breaching the boundary in 10.6.3, stop and ask.

When exiting, state plainly whether the exit criteria were met or the iteration cap was hit — never blur the two. On success, promote the final screenshots to `docs/ui-review/<module>/baseline/` so later phases can diff against them.

## 10.7 Report format

Produce `docs/self-check-<date>.md` and summarise in chat:

| Area | Status | Evidence | Notes |
|---|---|---|---|

Status is one of **verified** (executed, artifact attached), **failed**, **not applicable at this phase**, or **unverified** (with reason). Nothing else.

Then, separately:

1. **Findings**, ordered by severity, each with file, line, why it matters, and proposed fix. **Do not fix anything yet** — the list comes first. The only exception is the visual iteration loop in §10.6, where UI defects are fixed in-loop and reported.
1a. **The visual iteration log** — how many iterations ran, what was fixed each round, and whether the exit was on criteria or on the cap.
2. **Deviations from the brief** — anywhere implementation differs from the agreed architecture or conventions, deliberate or accidental.
3. **The named 5%** — what remains genuinely uncertain, what the checks structurally cannot catch, and what would close each gap.
4. **Honest confidence per module**, and where confidence is lowest.

If the true state is that something is not close to working, say so plainly. An accurate red report is far more useful than an optimistic green one.
