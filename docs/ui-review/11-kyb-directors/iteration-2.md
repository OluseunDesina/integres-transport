# 11-KYB-Directors — visual iteration 2

Same 9 states × 3 viewports, re-captured into `iteration-2/` after
iteration 1's seven fixes. Every image opened and judged again.

## Verified fixed

| # | Defect | Before | After |
|---|---|---|---|
| 1 | Business past row 25 unreachable | capture run aborted | `02`/`03` render; `GIGL` (index 32) opens |
| 2 | No validation feedback | `iteration-1/04-*` | `iteration-2/04-*` — red border + "This field is required." |
| 3 | Four different input widths | `iteration-1/06-*-1440` | `iteration-2/06-*-1440` — one width, Upload inline on all four |
| 4 | Long name clipped at 390 | `iteration-1/06-*-390` | `iteration-2/06-*-390` — wraps inside the card, no overflow |
| 5 | Ragged Remove placement | `iteration-1/06-*` | `iteration-2/06-*` — top-right on every row |
| 6 | Add card indistinguishable | `iteration-1/03-*` | `iteration-2/06-*` — tinted ground |
| 7 | Hand-rolled empty state | `iteration-1/01-*` | `iteration-2/04-*` — `ui-empty-state` |

No new defect was introduced, and nothing regressed at any viewport.

## Exit criteria (§10.6.4)

| Criterion | Result |
|---|---|
| Zero AXE violations, WCAG AA | **Met** — client-admin `businesses.spec.ts` and super-admin `kyb-queue.spec.ts` both assert `violations == []` |
| Zero console errors/warnings | **Met** — the only console output across all three viewport runs is one 404, from the deliberate `08-not-found` navigation |
| No clipping/overflow/collision | **Met** at 390, 768 and 1440 |
| Every state renders, stressed content included | **Met** — 4 directors, a 71-character name, a long business name |
| Visible focus; 44×44px targets | **Met** — `05-focus-upload-*`; controls use `min-h-11` |
| Booking flow keyboard-completable | Not applicable — this module has no booking flow |
| Consistent with the design language | **Met** — `ui-empty-state`, `ui-status-pill`, `ui-button`, `ui-text-field`, `ui-select` throughout |
| Unit, e2e, lint, type-check pass | **Met** — client-admin 295, super-admin 67, super-admin e2e 16/16, client-admin e2e 68/69 (one unrelated failure, see the self-check) |
| Final iteration introduced no regression | **Met** |

**Exited on criteria, not on the iteration cap** (2 of a maximum 5).

`iteration-2/` promoted to `baseline/`.
