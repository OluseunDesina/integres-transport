# Phase 2: Client-Admin + Super-Admin UI

Status: **Approved, not started.** No slice has been implemented yet.
Slice 1 (§7) requires its own plan-mode round and explicit go-ahead
before implementation begins, per the working agreement's per-slice stop-
and-review cadence — this spec is the "spec before code" deliverable, not
a green light to build all of it in one pass.

Phase 1 (`docs/specs/1-identity-client-business.md`) built a large
backend API surface — Business/KYC/KYB, Role/Permission/StaffInvitation,
WhiteLabelConfig, the client-invitation flow — but deliberately left
almost all of it without a UI screen, repeatedly deferring that work to
"Phase 2" throughout its own text. This spec is that phase: it adds no
new domain concepts, only screens (plus one small backend readback
endpoint, §2) for what Phase 1 already built and tested.

## 1. Scope and non-goals

**In scope** (all backend-only today; `client-admin-app` unless noted):

- Business list + create + edit — `GET/POST /businesses/`,
  `PATCH /businesses/{id}/`.
- Staff management: list + inline role/active edit, plus a separate
  invite form — `GET /staff/`, `PATCH /staff/{user_id}/`,
  `GET /staff/roles/`, `POST /staff/invitations/`.
- Client KYC status + document upload, Business KYB document upload —
  `GET /clients/me/` (new, §2), `POST /clients/me/kyc-documents/`,
  `POST /businesses/{id}/kyb-documents/`.
- White-label config, single-record settings form —
  `GET/PATCH /white-label/`.
- **`super-admin-app`**: KYC queue + KYB queue, each with an
  approve/reject-with-reason action —
  `GET/POST /super-admin/kyc-queue/...`,
  `GET/POST /super-admin/kyb-queue/...`. Plus an "invite a Client"
  create-only form — `POST /super-admin/client-invitations/`.
- A shared nav shell (`@layout`) used by both `client-admin-app` and
  `super-admin-app`, since neither has any persistent navigation chrome
  today — see §4.

**Explicitly deferred / non-goals:**

- Any Route/Trip/Schedule/Fare/Booking UI — Phase 3+, unchanged.
- Client-invitation and staff-invitation *accept/complete* screens — stay
  API/Playwright-only, the same precedent Phase 1 itself established for
  these exact flows (both are public, unauthenticated, token-based links
  with no natural place in an authenticated app shell anyway).
- A "pending invitations" list for either invite type — confirmed
  decision, not a gap left open: neither `apps/identity/staff_urls.py`
  nor `apps/clients/urls.py` has a `GET` returning previously-sent
  invitations, and none is being added this phase. Both invite screens
  are create-only forms with a success confirmation.
- `customer-app` — untouched by this phase.
- `ui-metric-card`, `ui-date-input`, `ui-money-input` from
  `docs/self-check.md` §10.6.2's full design-language vocabulary — no
  screen in this scope needs them (no dashboards/KPIs, no user-editable
  dates, no money fields anywhere in this endpoint set). Named
  explicitly as not-yet-built, not an oversight.
- Editing the 3 fixed Role presets, per-document (vs per-Client/Business)
  KYC/KYB decisions — both remain Phase 1 non-goals, unchanged.
- Threading a Client's white-label logo through the new nav shell — the
  shell shows a static app name in Phase 2; logo theming is a distinct,
  separable enhancement for whenever it's actually asked for.

## 2. Data model changes

None. This phase adds one read-only **view**, no new models, fields, or
migrations.

## 3. API surface

One new backend endpoint; everything else in this phase consumes
existing, already-tested Phase 1 endpoints unchanged.

| Method & path | Auth | Permission | Audited | Purpose |
|---|---|---|---|---|
| `GET /clients/me/` | client-admin | `client.view` | — | The caller's own Client's `kyc_status`, `kyc_submitted_at`, `kyc_rejection_reason`, and `documents` — the read-back Phase 1 never built (only `POST /clients/me/kyc-documents/` exists today). Mirrors `WhiteLabelConfigView.get()`'s "own Client" scoping and `ClientKycQueueSerializer.get_documents`'s explicit `KycDocument.all_objects.filter(client=...)` query pattern, just scoped to `request.user.client` instead of a cross-client queue. |

No new permission codenames — `client.view` already exists (seeded in
Phase 1 Slice 4) and already gates the KYC upload endpoint, so reusing it
here is consistent, not a new decision.

All other screens call, unchanged: `GET/POST /businesses/`,
`PATCH /businesses/{id}/`, `GET /staff/`, `PATCH /staff/{user_id}/`,
`GET /staff/roles/`, `POST /staff/invitations/`,
`POST /clients/me/kyc-documents/`, `POST /businesses/{id}/kyb-documents/`,
`GET/PATCH /white-label/`, `GET/POST /super-admin/kyc-queue/...`,
`GET/POST /super-admin/kyb-queue/...`, `POST /super-admin/client-invitations/`.

## 4. New `shared-ui` components and nav shell

Existing vocabulary (`ui-button`, `ui-text-field`, `ui-alert`) is thin,
presentational, `OnPush`, Tailwind-only — every new component below
matches that shape, not a generic framework:

- **`ui-status-pill`** — `label`/`tone`
  (`'neutral'|'positive'|'warning'|'negative'`) inputs. Domain-agnostic:
  each screen maps its own enum (`KycStatusEnum`/`KybStatusEnum`/
  `StaffInvitation.status`) to a tone via a local pure function: the
  component itself knows nothing about any of them.
- **`ui-paginator`** — `total`/`page` (reusing `shared-data`'s `Page`
  type) inputs, `pageChange` output. "X–Y of Z" + prev/next only, no
  page-number list — these lists are tenant-scoped and small.
- **`ui-select`** — a `ControlValueAccessor` component mirroring
  `TextField`'s exact shape (`label`, `options`, `errorMessage`,
  `invalid`) — for `vertical`/`booking_mode_default` on the Business form
  and the role picker on staff-invite. `currency`/`timezone` stay plain
  `ui-text-field`s (free-text ISO/IANA strings, not closed enums) — no
  searchable-select needed for those.
- **`ui-empty-state`** — `title`/`description` inputs + projected content
  for an optional action button.
- **`ui-table`** — a styling *shell* (border/spacing/hover-row/
  horizontal-scroll wrapper + loading/empty slot), not a column-def-
  driven grid — each screen still writes its own `<thead>`/`<tbody>`
  with `@for` inside it. Cheaper to build and test than
  `@angular/cdk/table` for 4 consumers with no sorting/filtering
  requirement; CDK's table is already a workspace dependency and worth
  reconsidering once there are 6+ tables or a real sort/column need —
  not now.
- **`ui-confirm-dialog`** — first real use of Angular CDK overlay in the
  repo, built on `@angular/cdk/dialog`'s `Dialog` service (manages focus
  trap/restoration correctly — unlike `AuthLayout`'s documented rejection
  of `cdkTrapFocus` for full standalone pages, a `Dialog`-backed modal is
  exactly the context CDK's focus trap is designed for). Generic API:
  `title`, `danger`, `confirmLabel`, projected body content, resolves a
  boolean. The KYC/KYB approve/reject-with-reason form itself is **not**
  a shared-ui component — used in exactly two places, both inside
  `super-admin-app` — built local to that app and projected into
  `ui-confirm-dialog`.

**Nav shell (`NavShell`, new in `@layout`)**: no app-shell-with-nav
exists anywhere today — `AuthLayout`/`ForbiddenPage` are both zero-
dependency standalone-card shells. `NavShell` is `layout`'s first
component with real service dependencies (`AuthStore` for sign-out,
currently duplicated ad hoc in each app's `Home`; `PermissionsService`
for nav-item filtering) — `layout`'s `peerDependencies` gains `@auth`, a
deliberate, low-risk widening (no enforced module-boundary tool in this
Angular-CLI-not-Nx workspace, just convention, and `layout`/`auth` are
already both cross-app infra by design).

Design, proportionate to 2–4 screens per app, not enterprise-sidebar
scale: a single horizontal top bar (static app-name string on the left; a
row of permission-filtered nav links in the middle, supplied per-app via
`navItems = input<{label: string; path: string; permissions:
readonly string[]}[]>([])`; the signed-in user's email + a sign-out
button on the right, replacing each app's currently-duplicated `Home`
sign-out logic) above a constrained `max-w-6xl mx-auto p-6` content
container wrapping a single `<router-outlet>`. Nav-item visibility reads
from `PermissionsService`'s existing permission set — the same source
`permissionGuard` and `*appHasPermission` already use, not a fourth,
divergent permission check. Routing shape: a parent route with
`component: NavShell` + `canActivate: [permissionGuard]` wrapping lazy-
loaded children, each still individually `data.permissions`-gated exactly
as `home` is today — the shell wraps existing guarding, it doesn't
replace it.

## 5. `ListStore` integration pattern

Every relevant list endpoint (`businesses_list`, `staff_list`,
`super_admin_kyc_queue_list`, `super_admin_kyb_queue_list`) takes only
`limit`/`offset` — no server-side filters exist anywhere in Phase 1, so
every concrete store's `TQuery` stays `ListStore`'s default
`Record<string, never>`; `updateQuery()` goes unused this phase but
remains available for whenever real filters land in a later phase.

Pattern, e.g. `BusinessStore` at
`client-admin-app/src/app/shared/data/store/business.store.ts` (per
CLAUDE.md's existing "concrete stores live per-app" convention —
`shared-data` only ever holds the abstract base):
`@Injectable({providedIn:'root'})`, `extends ListStore<Business>`,
`super({}, 25)` in the constructor, injects `API_CLIENT`, implements
`protected fetchPage(query, page)` calling
`this.api.GET('/api/v1/businesses/', {params:{query:{limit: page.limit,
offset: page.offset}}})`, throws on `error`/missing `data` (mirrors how
`AuthApiService` already surfaces DRF errors, though the throw-based
shape here is intentionally different from `AuthApiService`'s
`LoginResult` return type — `ListStore.getAll()`'s `catch` expects a
throw), and returns `{items: data.results, total: data.count}` — the
exact `{count,next,previous,results}` → `{items,total}` mapping every
paginated envelope in `schema.ts` needs. The same ~15-line shape repeats
for `StaffStore`, `KycQueueStore`, `KybQueueStore` — not worth a generic
factory for four consumers.

This phase is `ListStore`'s first production consumer anywhere in the
repo (confirmed via `grep "extends ListStore"` — the only existing match
is a test fixture in `list-store.spec.ts`), closing the exact risk Phase
0's own self-check named: "Lower confidence on long-term ergonomics of
`ListStore` specifically, since nothing has used it yet."

## 6. Edge cases

- **Business list/create/edit**: creating a Business while the Client's
  own KYC is still `pending` is allowed (Phase 1 §6 already establishes
  this at the API level — the UI must not add a client-side block that
  the backend doesn't enforce). Duplicate `vertical` across two
  Businesses under the same Client is allowed (same reasoning). Long
  Business names must not break the table layout — stress-tested in the
  visual iteration loop, not just assumed.
- **Staff list/invite**: inviting an email already staff at the same
  Client shows the exact backend error (`already a member`) as a field-
  level error, not a generic banner. Deactivating the last remaining
  Owner-role staff member is *not* blocked by this UI (the backend
  doesn't block it either — out of scope to invent a new server-side
  rule here; flagged for whenever that's decided, not silently added).
- **KYC/KYB queues**: rejecting requires a non-empty reason (already
  enforced server-side by `KycDecisionSerializer`/`KybDecisionSerializer`
  — the UI must surface that validation error inline in
  `ui-confirm-dialog`, not just show a generic failure). A queue row
  disappearing mid-review (another platform-staff member already decided
  it) must produce a clear "already decided" state on submit, not a
  silent failure or a stale-looking success.
- **Client KYC / Business KYB document upload**: uploading while status
  is already `approved` is allowed by the backend (any upload while
  `pending`/`rejected` flips to `submitted`; an upload while `approved`
  just adds a document without changing status, per Phase 1 §6's
  literal rule) — the UI should not block this, but should make clear
  the status didn't change if the user expected it to.
- **White-label config**: first visit to the screen for a Client with no
  `WhiteLabelConfig` row yet must not error — `GET /white-label/` already
  `get_or_create`s server-side, so the form just renders with blank
  defaults.
- **Client-invitation / staff-invitation create forms**: submitting with
  an email that's already invited-but-pending shows the backend's exact
  duplicate/already-a-member error inline, not a generic failure.

## 7. Failure modes

- **Network/API failure on any list screen**: `ListStore.error` signal is
  already designed for this (`getAll()`'s `catch` sets it) — every list
  screen must render a distinct error state (not just an empty table),
  per `docs/self-check.md` §10.6.1's required state matrix.
- **`ui-confirm-dialog` closed mid-submit** (e.g. browser back button
  while a decide-request is in flight): the in-flight request must not
  silently update stale UI state after the dialog is gone — each screen
  using the dialog is responsible for ignoring a resolved-but-stale
  response if the dialog was dismissed first.
- **Nav-shell permission mismatch**: if `PermissionsService`'s set
  changes mid-session (e.g. a staff member's role is downgraded by
  another admin while they're signed in), nav items and route guards
  must stay consistent with each other — both already read the same
  signal, so this is a property to *verify*, not a new mechanism to
  build.

## 8. Test plan

Backend: one new test file for `GET /clients/me/` (permission gating on
`client.view`, correct field shape, cross-client isolation — reusing the
existing RLS/tenancy test patterns, not inventing a new one). Everything
else in this phase is frontend-only against already-tested Phase 1
endpoints; no new backend cross-cutting tests required.

Frontend (Karma/unit): each `ListStore` subclass
(`{count,results}`→`{items,total}` mapping, error path); each new
`shared-ui` component in isolation (`ui-status-pill` tone mapping,
`ui-paginator` offset math, `ui-select`/`ui-table` rendering);
`NavShell`'s permission-filtering logic; `ui-confirm-dialog`'s
open/confirm/cancel/focus-restoration behavior.

E2E (Playwright + axe, per new screen): full state matrix per §10.6.1
(loading/empty/populated/error/validation-error/success/permission-
denied), captured at 390/768/1440px (1440 authoritative for both
`client-admin-app` and `super-admin-app`). `ui-confirm-dialog` gets
dedicated keyboard-only + focus-restoration coverage — it's the first
modal in the repo, and `AuthLayout`'s own documented rejection of
`cdkTrapFocus` outside a true modal context is a concrete warning this
class of component is easy to get subtly wrong even with CDK's help.
Stress content per §10.6.2: long Business/Staff names, 50-row tables for
all four lists (otherwise only ever demoed with 1–3 rows), zero-row
states, the longest realistic KYC/KYB rejection reason.

## 9. Migration impact

None — no schema changes (§2). `GET /clients/me/` is a new, additive,
read-only endpoint.

## 10. Suggested implementation slicing

Per the working agreement (thinnest vertical slice, stop for review),
proposed order:

1. **Nav shell + Business list/create/edit (`client-admin-app`).**
   Deliberately the largest slice, same justification Phase 1 gave Slice
   1 (RLS proven against `TenancyProbe` before any real model depended on
   it) — this is the one slice that has to prove `NavShell`,
   `ListStore`'s first real subclass, `ui-table`, `ui-paginator`,
   `ui-status-pill`, `ui-select`, and `ui-empty-state` all at once, since
   a shared-ui component's correctness is judged in situ by the visual-
   iteration loop, not in isolation. Business list is the right
   thinnest-real-screen: no nested review action, no CDK dependency.
   Create *and* edit both included, not list-only — a read-only table
   isn't a demoable end-to-end slice.
2. **Staff management + invite (`client-admin-app`).** List + inline
   role/active edit (a `ui-select` per row, `PATCH` on change — no
   dialog, no reason field) + a separate invite form (`GET /staff/roles/`
   populates the role picker). Zero new shared-ui components — proof
   that slice 1's output is genuinely reusable, not a one-off.
3. **KYC + KYB review queues, combined (`super-admin-app`).** Mirrors
   Phase 1's own Client-KYC/Business-KYB "one slice, near-identical
   shape" precedent. First use of `ui-confirm-dialog` (built once, used
   twice) and the first time `NavShell` gets wired into a *second* app —
   proves it's genuinely shared. Higher priority than staff/white-label:
   these queues are the actual operational bottleneck nothing else can
   get approved without.
4. **Client KYC status + document upload, Business KYB document upload
   (`client-admin-app`).** Placed after the queues deliberately, since
   it's blocked on §2's `GET /clients/me/` backend addition — shouldn't
   be the thing everything else waits on. Bundles Client-KYC and
   Business-KYB upload together (same mirror-shape reasoning as slice 3).
   A small file-upload widget lives local to
   `client-admin-app/src/app/shared/` (used twice, not shared-ui-worthy).
5. **White-label config (`client-admin-app`).** Single-record settings
   form — no `ListStore`/table/CDK, zero new shared-ui components (reuses
   `ui-text-field`/`ui-button`/`ui-alert` only). Lowest-risk slice,
   correctly last among `client-admin-app`'s screens.
6. **Super-admin "invite a Client" create form (`super-admin-app`).**
   Form + success alert only, reusing slice 2's invite-form pattern and
   slice 3's `NavShell`-in-`super-admin-app` wiring — cheap by the time
   it's reached.

Each slice still gets its own stop-and-review per the working agreement
— this is a proposed order, not a request to build all six in one pass.
