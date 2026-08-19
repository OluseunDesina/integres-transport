# Self-check — Phase 2 (Client-Admin + Super-Admin UI) — 2026-08-08

Scope: all 6 Phase 2 slices (`docs/specs/2-client-admin-super-admin-ui.md`)
— Nav shell + Business list/create/edit, Staff management + invite,
KYC/KYB review queues (`ui-confirm-dialog`, first CDK usage in the repo),
Client KYC status + document upload + Business KYB document upload,
White-label config, and Super-admin "invite a Client." Each slice was
individually verified (lint/test/build/e2e) at the end of its own slice;
this is the first **phase-level** self-check, run after all 6 landed —
same cadence Phase 1's own self-check established
(`docs/self-check-2026-08-08.md`). Booking/payment/wallet/ledger/ticket
items in §10.2–§10.3 remain **not applicable at this phase**, unchanged.

This report closes out Phase 2 as a genuine product milestone: all 3
frontend apps now have real UI beyond login/home, not just backend API
surface.

## 10.7 Report table

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Angular v20 convention greps (§10.1) | verified | All 11 greps (`standalone: true`, `@HostBinding`/`@HostListener`, `*ngIf`/`*ngFor`/`*ngSwitch`, `ngClass`/`ngStyle`, `@Input()`/`@Output()`, `.mutate(`, `*.component.ts`, deep relative imports, `: any`/`<any>`/`as any`, `@ngrx`, hardcoded URLs) returned zero matches across `frontend/projects/`, except the same generated `@example` doc-comment URLs inside `schema.ts` Phase 0/1 already excluded | |
| `OnPush` on every component | verified | Scripted check over every `@Component`-decorated, non-spec file across all 7 new screens + `NavShell` + 5 new `shared-ui` components — zero missing | |
| Reactive forms only, `ngModel` audited | verified | 3 files use standalone `ngModel` (`business-form.html`, `kyc-status.html`, `staff-list.html`) — all 3 are the documented, deliberate exceptions from each slice's own plan (KYC/KYB upload document-type selects; staff inline role/active edit), no undocumented usage | |
| Backend `ruff check .` / `mypy .` | verified | `All checks passed!` / `Success: no issues found in 88 source files` | |
| Backend `pytest` suite | verified | `129 passed`, 98% coverage (`--cov=apps`) — up from 128/98% at end of Slice 6; the one new test this round is `test_client_me.py`'s query-count regression test (§10.5) | |
| `GET /clients/me/` has a test file | verified | `apps/clients/tests/test_client_me.py` — 5 tests: own-Client fields, documents reflect an uploaded KYC document, passenger forbidden, unauthenticated rejected, query count flat | |
| Every named URL has a test | verified | All 27 named URLs across `core`/`clients`/`businesses`/`identity` (`urls.py`+`staff_urls.py`) have at least one `reverse()` call in the suite — scripted diff, zero missing (unchanged from Phase 1 — Phase 2 added no new backend routes) | |
| OpenAPI spec regenerates with no diff | verified | Backend `check_openapi_drift.sh` → `OpenAPI schema matches committed openapi.yaml.`; frontend `openapi:check` → `api-client schema.ts matches backend/openapi.yaml.` | Same 2 pre-existing enum-naming warnings as Phase 1, cosmetic, unchanged |
| Migrations | verified — none this phase | `find apps -name migrations` shows the identical migration file list as Phase 1's own report | Matches spec §9's "no schema changes" exactly |
| Playwright e2e, full run (§10.3) | verified | **43/43 pass in one combined serial run across all 3 apps** (`client-admin-app` 22, `super-admin-app` 14, `customer-app` 5, `--project` for all three in a single invocation) — traces captured | This is the first time this session the full suite has passed together without per-file isolation; see Findings #2–#3 |
| Flow 1 — registration→business→KYC/KYB→approve→sign-in | verified (mixed UI/API) | The "approve" step now has real UI for the first time (Slices 3's queues); registration/business/upload steps stay UI where Phase 1/2 built screens for them. No single test chains all 5 steps — same honest gap Phase 1's report named, still true | See named 5% |
| Flow 2 — super-admin invites a client → completes onboarding | verified (API-only, confirmed non-goal) | Unchanged from Phase 1 — `test_client_invitations.py`'s full chain test; the invite-*creation* screen is new this phase (Slice 6), the accept/complete screen remains out of scope by design | |
| Every reachable screen has e2e coverage | verified | 11 spec files map 1:1 to the 7 new screens + login/register/staff-invite-adjacent flows in both apps, listed by name in §10.3 verification below | |
| Accessibility — axe on every state (§10.4) | verified, 2 real findings fixed | See Findings #1, #4 | |
| Keyboard-only completion | verified, expanded | Added for Business create (`businesses.spec.ts`) and the KYC queue decide dialog's full radio→textarea→button flow (`kyc-queue.spec.ts`) — both previously unverified, now permanent regression tests | `register.spec.ts`/`login.spec.ts`'s existing coverage unchanged |
| Tenancy enforced structurally, `all_objects` audited (§10.5) | verified | `grep -rn "\.all_objects\." apps/ --include="*.py" \| grep -v tests/` → 12 hits, all matching Phase 1's already-documented set — zero new undocumented usage (Phase 2 is frontend-only except one `.objects`-scoped read-only view) | |
| No secrets committed | verified, same caveat as Phase 1 | `.env` correctly `.gitignore`d; repo still has zero commits, so this confirms `.gitignore` correctness, not "nothing leaked" | |
| Rate limiting active + budget resolved | verified — real decision made, not deferred | See Finding #3 | Phase 1's report explicitly left this decision open; this round makes the call |
| Audit records | verified — no new call sites needed | Phase 2 added no new privileged/money-moving actions (frontend-only + one read-only endpoint) — confirmed by diffing `record_audit_event` call sites against Phase 1's list: identical | |
| Query counts on list/detail endpoints (N+1) | verified | `GET /clients/me/` (the one new endpoint) — new `django_assert_max_num_queries(10)` test with 5 documents, passes; every list/queue endpoint's N+1 fix from Phase 1 unchanged | |
| Visual iteration loop (§10.6) | verified, full rigor | 120 screenshots (40 states × 3 viewports) across all 7 new screens, reviewed by 3 delegated agents then independently re-verified live. 3 real fixes applied, several false alarms correctly identified and not fixed. Full detail: `docs/ui-review/2-client-admin-super-admin-ui/iteration-1.md` | |

## Findings, ordered by severity

1. **[Fixed, real WCAG AA violation] `ui-button`'s disabled state used `disabled:opacity-50`, which fails contrast on any background darker than pure white.** First surfaced on the Businesses list paginator's disabled Previous/Next buttons (contrast measured 2.4–3.8:1 against `bg-slate-50`, below the 4.5:1 minimum) — confirmed via axe against the real, settled (non-transitioning) DOM state, not inferred from a screenshot. This is a shared-component bug, so it affected every disabled button in both apps, not just the paginator. Fixed in `projects/shared-ui/src/lib/button.ts`: disabled state now uses explicit `bg-slate-100`/`text-slate-700` (already proven elsewhere in this app via `ui-status-pill`'s neutral tone) instead of opacity, for all three variants. New `button.spec.ts` case. Re-verified with axe: zero violations, including on the confirm-dialog's disabled Reject button which visually still reads as "muted" but authoritatively passes AA.
2. **[Fixed, real test-isolation gap, not a product bug] `kyc-queue.spec.ts`/`kyb-queue.spec.ts`'s final test asserted the entire queue empties after deciding one row — an assumption that breaks the moment more than one Client/Business is genuinely `submitted` at once, which is also just how the real product behaves (the queue is meant to hold multiple concurrent submissions).** Confirmed deterministic, not flaky: `client-admin-app`'s own e2e suite submits real KYC documents against a shared seeded Client and creates real Businesses that reach `submitted` KYB status, and those legitimately coexist with each queue test's own dedicated fixture row. Fixed by scoping both tests' final assertion to the specific row (`expect(row).not.toBeVisible()`) instead of "no submissions to review" — this is both a correctness fix and a closer match to real product behavior. A backlog of 6 real "E2E Shuttle Co" Businesses and one Client's `kyc_status` that had drifted to `submitted` from earlier sessions were reset to unblock local testing (data cleanup, not a code change).
3. **[Fixed, real decision made] The shared auth-throttle budget (Phase 1 self-check Finding #4, previously split into 5 per-purpose scopes but left at 10/min each) had been hit three separate times across Slices 4–6 as each app's own Playwright suite grew past its own dedicated scope's ceiling — this round makes the call Phase 1's report deliberately deferred.** Resolved by widening the 5 auth throttle rates to 100/min in `config.settings.local` only (`backend/config/settings/local.py`) — production, staging, and `config.settings.ci` (what `pytest`/real CI actually run under) keep the original strict 10/min unchanged, so the actual security-relevant rate limit is untouched anywhere it matters. Verified live: `test_throttling.py` (which runs under `ci` settings) still enforces 10/min correctly; the full 43-test Playwright suite across all 3 apps now passes in one combined serial run with zero throttling, where it previously required per-file isolation to avoid it.
4. **[Fixed, real accessibility-adjacent test bug, not a product bug] `kyc-status.spec.ts`'s upload test had a non-deterministic axe "violation"** (contrast ratio varied 3.42–3.83 across identical reruns) — root-caused to the axe scan sometimes sampling a mid-CSS-transition frame of the Upload button's `disabled → enabled` opacity animation, not a fixed defect (confirmed via 3 consecutive isolated reruns producing 3 different contrast values, which a deterministic bug wouldn't). Fixed by waiting for the button's computed `opacity` to settle to `1` before running axe, rather than scanning immediately after the action that triggers the transition.
5. **[Fixed, real consistency defect] List-screen error states across 6 files rendered as bare unstyled red text (`<p role="alert" class="text-sm text-red-600">`) instead of the bordered/tinted `ui-alert` component every other error state in both apps uses** — confirmed directly (not just from a screenshot) by viewing the KYC Status screen's load-error state next to its own upload-error state, which use two different patterns on the same page. Fixed in `business-list.html`, `staff-list.html`, `kyc-status.html`, `white-label.html`, `kyc-queue.html`, `kyb-queue.html` — swapped to `<ui-alert>`, added the missing import in 3 of the 6 components.
6. **[Fixed, real WCAG tap-target violation] `NavShell`'s nav links measured well under the 44×44px minimum** (20–40px tall, as narrow as 31px wide for "Staff") — measured live via `boundingBox()` at 390px, not estimated from a screenshot. Fixed in `projects/layout/src/lib/nav-shell.ts`: nav links now use `inline-flex min-h-11 items-center px-1`, matching the `min-h-11` convention `ui-button`/`ui-text-field` already established.
7. **[Process finding, not a product defect] The visual-review delegation surfaced several findings that turned out to be capture-script artifacts, not real defects** — two "disabled button looks washed out/illegible" claims and one "list screen stuck on Loading forever" claim were all the capture script screenshotting before a CSS transition or async load had settled, not a genuine rendered state. Caught by re-verifying live (computed styles, DOM measurements, and axe against the settled state) before treating any agent-reported finding as actionable — none of these were fixed in product code; the capture script's own settle-wait was fixed instead and affected screens recaptured. Recorded here because it's a real methodology lesson: screenshot-based review needs the same "don't trust it until it's settled" discipline as any other async UI testing, and a delegated agent has no way to know a screenshot is mid-transition.
8. **[Observation, not a defect, unchanged from Phase 1] The same 2 `drf-spectacular` enum-naming-collision warnings** (`StatusE94Enum`, `KycStatusEnum` reused across choice sets) — schema still valid, drift-check still passes, not touched.
9. **[Not fixed — judged acceptable, minor] The KYC/KYB queue tables genuinely overflow at 390px width.** Confirmed the horizontal scroll mechanism itself works correctly (`ui-table`'s `overflow-x-auto` wrapper: measured `scrollWidth` 591px vs `clientWidth` 340px, i.e. content is reachable, not lost) — the gap is a missing visual affordance (no shadow/fade hint that more columns exist off-screen), not broken functionality. Judged minor/polish rather than a blocker; not fixed this round.

## 1a. Visual iteration log

One iteration, exited on criteria met (not the 5-iteration cap). Full
detail in `docs/ui-review/2-client-admin-super-admin-ui/iteration-1.md`.
Summary: 120 screenshots across all 7 new screens (every state ×
390/768/1440px, 1440 authoritative), all opened and reviewed — full
rigor per explicit user choice, not a sampled subset. Review delegated to
3 parallel agents to protect this session's own context window, then
every finding independently re-verified live before acting (see Finding
#7). Three real defects found and fixed (button contrast, error-state
consistency, nav tap-target sizing); several agent-reported findings
correctly identified as capture-script artifacts and left alone.
Screenshots promoted to `docs/ui-review/2-client-admin-super-admin-ui/baseline/`.

## 2. Deviations from the brief

- **`config.settings.local` now has its own `DEFAULT_THROTTLE_RATES`
  override** (Finding #3) — a new, deliberate divergence between local
  and production/staging/CI throttle behavior. Documented inline in the
  settings file itself with the reasoning, not silent.
- **`ui-button`'s disabled-state styling changed from opacity-based to
  explicit-color-based** (Finding #1) — a visual change to every disabled
  button in both apps, not scoped to the screen that surfaced it. No
  screen's test assertions depended on the old opacity classes, so this
  shipped with zero test breakage, but it's a real, phase-wide styling
  change worth naming as a deviation from what Slice 1's original design
  looked like.
- **`kyc-queue.spec.ts`/`kyb-queue.spec.ts`'s final assertion changed
  from "queue empties" to "this row leaves"** (Finding #2) — a
  correctness fix, but also a scope-narrowing of what that test actually
  proves (it no longer incidentally asserts the queue has exactly one
  row at that point in the suite, which was never a real product
  invariant to begin with).
- Everything else matches `docs/specs/2-client-admin-super-admin-ui.md`
  as written — no scope, permission, or data-model deviations.

## 3. The named 5%

- **Focus-ring visual rendering was not independently verified beyond
  what the keyboard-only e2e tests exercise.** Those tests confirm focus
  *moves* to the right element via `.toBeFocused()`, and `ui-button`/
  `ui-text-field`/etc. all carry `focus-visible:outline` classes by
  convention — but no test asserts the outline is actually *visible*
  (non-zero width, sufficient contrast) at the moment of focus. Static
  screenshots can't capture this either, since Playwright doesn't focus
  elements during a plain `page.screenshot()`. A real gap, not assumed
  away.
- **The longest-realistic KYC/KYB rejection reason was not stress-tested
  in a captured screenshot** — self-check.md §10.6.2 calls for this
  explicitly; the reject-validation dialog captures used a moderate-length
  reason string, not a deliberately long one.
- **Flow 1's five steps (registration→business→KYC/KYB→approve→sign-in)
  still aren't chained into one continuous test** — unchanged from Phase
  1's own honest finding on this. The "approve" step gaining real UI this
  phase didn't close this gap, since no single test drives all five steps
  end-to-end through the browser.
- **The CI workflow has still never actually run** — same gap Phase 0
  and Phase 1's reports both named, still true.
- **The repo still has zero git commits** — unchanged since Phase 0.
- **The visual-review delegation's own false-positive rate (3 of roughly
  10 distinct findings across 3 agents) is worth naming as a process
  characteristic, not just a one-off**: agents reviewing static
  screenshots have no way to distinguish a genuinely broken state from a
  mid-transition capture artifact. This self-check caught it by
  re-verifying live before fixing anything, but a future phase that
  skips that re-verification step risks either shipping unnecessary
  "fixes" for non-bugs or, worse, papering over a real bug's symptom
  (e.g., adding a settle-wait to a test) without checking whether the
  underlying settled state is actually correct. Worth keeping this
  verify-before-fix discipline explicit in future visual loops, not just
  this one.

## 4. Honest confidence per module

- **`shared-ui` (Button, StatusPill, Table, Paginator, Select,
  EmptyState, ConfirmDialog)**: high confidence. The one real defect
  found (Button's disabled-state contrast) was systemic and would have
  affected every future screen using disabled buttons — fixed at the
  component level with a regression test, not patched per-screen. CDK
  Dialog's focus trap/restoration/keyboard operability now has dedicated
  test coverage (Finding-adjacent: the new keyboard-only decide-dialog
  test) beyond just the Escape-to-close case Slice 3 originally shipped.
- **`layout` (`NavShell`)**: high confidence after this round — the
  tap-target fix was found and closed with a live measurement, not
  guessed at. Low-to-medium confidence *before* this self-check, since
  nothing had checked tap-target sizing on the actual rendered nav until
  now.
- **`client-admin-app` screens (Businesses, Staff, KYC Status, White
  Label)**: high confidence. Every screen's full state matrix was
  captured, reviewed, and (where findings were real) fixed; unit +
  e2e + lint + build all pass with no regression from any fix.
- **`super-admin-app` screens (KYC/KYB Queue, Invite Client)**: high
  confidence, with the queue tests' correctness fix (Finding #2) reading
  as the more valuable catch here than anything visual — it was a latent
  false assumption about production behavior, not just a test-hygiene
  issue.
- **Backend (`GET /clients/me/`, throttle config)**: high confidence.
  The one new endpoint got the N+1 check every other list/queue endpoint
  already had; the throttle decision was made explicitly and scoped to
  minimize blast radius (local-only, not production/CI).
- **Overall Phase 2**: meets the brief's ~95% standard for what's
  actually built. Three real, user-facing defects (one WCAG AA
  violation, one inconsistency, one tap-target violation) and one real
  test-correctness bug were found and fixed specifically *because* this
  self-check re-verified agent-reported findings live instead of trusting
  screenshots at face value — the same "measure, don't just read the
  code" discipline that made Phase 1's self-check valuable (the N+1s,
  the audit-log gap) paid off again here, just applied to visual/UX
  claims instead of query counts.
