# 11-KYB-Directors — visual iteration 1

Screens: `client-admin-app` `businesses/:id/kyb` (new), and
`super-admin-app` `kyb-queue` (modified — Directors column).

Captured 9 states × 3 viewports (390 / 768 / 1440) into
`iteration-1/`. Authoritative viewport: **1440** (client-admin).
Every image was opened and judged, not reasoned about from markup.

## What the capture run itself found, before any screenshot

The capture script could not reach two of its three target businesses.
That was not a scripting error — it was the screen's first real defect,
and only a run against real data could surface it.

## Defects

| # | Screen | Viewport | State | Severity | Defect | Evidence |
|---|---|---|---|---|---|---|
| 1 | KYB | all | populated | **High** | Any business outside the store's first 25 rendered "That business couldn't be found." | Capture run aborted on `e0f5bf7c` (list index 25) and `GIGL` (index 32) |
| 2 | KYB | all | validation | **High** | Pressing "Add director" on an empty form did nothing visible — no message, no field highlight | `04-validation-error-1440.png` |
| 3 | KYB | 1440 | stress | Medium | Four director rows rendered four different file-input widths; a long name wrapped Upload onto its own line | `06-stress-long-names-1440.png` |
| 4 | KYB | 390 | stress | Medium | Long director name clipped past the card's right edge | `06-stress-long-names-390.png` |
| 5 | KYB | 390/1440 | stress | Low | Remove button sat inline on some rows, wrapped below on others | `06-stress-long-names-*.png` |
| 6 | KYB | all | populated | Low | "Add a director" card was visually identical to a director row | `03-populated-approved-1440.png` |
| 7 | KYB | all | empty | Low | Empty state hand-rolled the dashed box `ui-empty-state` already provides | `01-empty-1440.png` |

### 1 — Business lookup bounded to one page (High)

`business-kyb.ts` resolved the business from `BusinessStore`'s loaded
page, refetching once. `BusinessStore`'s page size is 25; the dev
database holds 77 businesses. Anything from index 25 on was
unreachable, and `GIGL` — real, non-fixture data with 3 directors and 4
documents — could not be opened at all.

Copied verbatim from `business-form.ts`, whose own docstring recorded
the behaviour as an accepted limitation. It isn't one. This is the same
"bounded fetch, `.find()` by id, silent fallback" family CLAUDE.md
already records being fixed twice — `SelectedBusinessStore` and
`BusinessSuperAdminStore.findById()`.

Earlier live verification of this screen missed it entirely because it
used a freshly created business, which sorts first under
`-created_at` and is therefore always on page 1.

**Fixed**: `BusinessStore.findById()`, mirroring the super-admin
precedent — checks the loaded page, then pages the full list directly
against the API without touching browse state. Adopted by both
`business-kyb.ts` and `business-form.ts`. Four store tests, including
one that reproduces the exact broken case (id at index 40 of 77) and
one asserting the lookup never disturbs `business-list`'s pagination.

### 2 — No validation feedback at all (High)

`ui-text-field` and `ui-select` render an error only when the parent
binds `[invalid]` and `[errorMessage]`; they do not read their own
control's validity. This template bound neither, so an empty submit
called `markAllAsTouched()` and produced nothing on screen.

The unit test covering this asserted only that `POST` was not called —
the model, never the rendered output — so it passed throughout.

**Fixed**: a `fieldError()` helper matching `business-form.ts`'s, bound
on both fields. The test now asserts the visible message and
`aria-invalid` too.

### 3–5 — Layout driven by name length (Medium)

A `flex flex-col` block sizes to its widest child. The widest child was
the label, which is built from the director's name — so the file input
grew with the name, and a long enough name pushed Upload to a second
row and clipped the label at 390px.

**Fixed**: `min-w-0 flex-1 sm:max-w-sm` on the wrapper, `w-full` on the
input, `wrap-anywhere` on the label; same treatment on the company
sections, and `min-w-0 flex-1` on the director header row.

### 6–7 — Design-language drift (Low)

**Fixed**: `bg-slate-50` on the add-director card; `ui-empty-state`
replacing the hand-rolled dashed box.

## Not fixed — reported instead

- **KYB queue has no search.** 36 near-identical rows, paginated 25 at
  a time, no filter. A reviewer cannot find a named business. New
  functionality, out of this pass's scope.
- **`NavShell` keeps a ~45px icon rail at 390px** instead of collapsing
  to an overlay. Costs 12% of the viewport on every client-admin
  screen. Pre-existing, shared, and 390 is not this app's authoritative
  viewport.
- **Document status stays `pending` on an approved business.** Approval
  is recorded at business level, not per document, so an approved
  packet shows all-pending documents. Backend semantics — §10.6.3 bars
  fixing that in this loop.

## Exit

Not exited at iteration 1. Re-captured as iteration 2.
