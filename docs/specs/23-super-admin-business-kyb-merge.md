# 23-Super-admin-business-kyb-merge: one filterable Business list, not two overlapping pages

Requested directly against the shipped `super-admin-app`: the separate
Business list and KYB review queue pages both rendered `Business` rows
with no way to cross-filter between the two screens (a reviewer wanting
"submitted businesses in the intercity vertical" had no such view on
either page). Merges them into one list with `kyb_status`/`vertical`/
`is_active` filters and moves the KYB review action onto it, using the
three-dot `ui-action-menu` convention `client-admin-app` already
established, rather than the plain link buttons the Business list used
before.

## Scope and non-goals

### In scope

- `GET /api/v1/super-admin/businesses/` gains `kyb_status`/`vertical`/
  `is_active` query-param filtering, alongside the existing `search`.
- `business-list.ts` (super-admin-app) gains three filter dropdowns
  wired through the existing `ui-filter-bar`/chips pattern, and a
  `ui-action-menu` per row (Paystack account / Settlements / Seat hold,
  plus a **Review KYB** item that only appears while
  `kyb_status === 'submitted'`) replacing the three plain links it
  rendered before.
- The KYB-decide `ConfirmDialog` flow (decision radio, reason textarea,
  `POST /super-admin/kyb-queue/{business_id}/decide/`) moves from the
  KYB queue page into the Business list, reused as-is — the decide
  endpoint itself is unchanged.
- The separate `kyb-queue` page/route/store is removed; the "KYB queue"
  nav item and the home dashboard's matching destination card are
  removed with it. The notification resolver's `KybDocument` case now
  points at `/businesses` instead.

### Non-goals (deferred, not silently dropped)

- No change to `KybQueueListView`/`KybDecideView` on the backend —
  both endpoints are unchanged; only the frontend page that used to
  render the list endpoint is gone. Nothing currently reads that list
  endpoint any more, but it was not removed (see Implementation note).
- No query-param preset when navigating from a `KybDocument`
  notification to `/businesses` — `NotificationRouteResolver` returns
  plain route commands with no query-param support, so a reviewer lands
  on the unfiltered list and applies the `kyb_status=submitted` filter
  themselves rather than the old queue page's implicit one.
- No change to director/document detail — the KYB queue's own richer
  per-row shape (director names, document count) is not carried into
  the merged list; the review dialog itself never needed that data
  (decision + reason only), and the merged list's own row shape is the
  Business list's, not the queue's.

## Data model changes

None. `Business.kyb_status`/`vertical`/`is_active` already exist; this
is a read-side filtering addition only.

## API surface

- `GET /api/v1/super-admin/businesses/?search=&kyb_status=&vertical=&is_active=`
  — all four params optional, validated by a new
  `BusinessSuperAdminQuerySerializer`, applied as independent,
  narrowing-only `.filter()`s. `is_active` is a `"true"`/`"false"`
  `ChoiceField`, not a `BooleanField` — see Implementation note for why.
- No other endpoint changed. `POST /super-admin/kyb-queue/
  {business_id}/decide/` is called from a different frontend screen, but
  its request/response shape and auth are exactly as before.

## Edge cases

- **A business is approved/rejected while the merged list is on screen
  with a `kyb_status=submitted` filter applied**: it drops out on the
  next fetch (the dialog's own `ref.closed` handler already refetches
  after a real decision), the same behaviour the old queue page had.
- **The Review KYB item on a business whose status is not `submitted`**:
  absent from the menu entirely, not present-and-disabled — matches the
  existing conditional-item convention `client-admin-app`'s own
  `menuItems()` already uses elsewhere, rather than introducing a new
  disabled-item pattern for this one case.
- **`is_active` omitted from the query entirely**: must not filter at
  all (see Implementation note's `BooleanField` finding — this is the
  actual bug this spec's own test suite caught, not a hypothetical).

## Failure modes

Unchanged from both predecessor screens — the query serializer 400s on
an unrecognised `kyb_status`/`vertical` value (a real `ChoiceField`,
not a raw string filter), same posture the rest of this codebase's
list-query serializers already take.

## Test plan

Backend: each of the three new filters narrows independently and in
combination with `search` and with each other; an unrecognised
`kyb_status` value 400s; the pre-existing cross-client-visibility and
plain-`search` tests continue to pass unmodified.

Frontend: filter dropdowns call `store.updateQuery()` with the right
shape; the removable chip per active filter; the action menu's fixed
three items plus the conditional fourth; the KYB decide dialog's title,
disabled-until-reasoned-reject state, refetch-only-on-real-decision
behaviour, and success/failure `onConfirm()` outcomes — all moved
verbatim from the old `kyb-queue.spec.ts`, not rewritten from scratch.

## Migration impact

None.

## Implementation note

Shipped backend-then-frontend in one pass, verified with the full
backend suite (fresh `--create-db`) and the full frontend `test:all`/
`ng lint`/`ng build:all` chain across every project before and after.

**What was found only by running the real test suite, not by reading
the code**: the first version of the `is_active` filter used
`serializers.BooleanField(required=False)`. DRF's `Field.get_value()`
treats a `QueryDict` (which is what a `GET` request's query params are)
as HTML form input — and for a `BooleanField` specifically, a *missing*
key under that treatment resolves to `False` rather than staying absent
from `validated_data`, the same way an unchecked HTML checkbox submits
nothing. The effect: every unfiltered request to the merged list
silently got `is_active=False` applied, hiding every active Business —
caught by `test_platform_staff_sees_businesses_across_multiple_clients`
(a pre-existing, unrelated test that asserts nothing about `is_active`
at all) failing outright, not by any test written for this feature.
Fixed by making `is_active` a `"true"`/`"false"` `ChoiceField` instead,
converted explicitly in the view (`value == "true"`) — the same fix
`kyb_status`/`vertical` never needed, since `ChoiceField` has no
equivalent HTML-form special case.

**Verification performed**: backend `apps/businesses` suite (84 passed)
plus the full backend suite (1246 passed at the time, fresh
`--create-db`), `ruff`/`mypy` clean, OpenAPI regenerated with zero
drift. Frontend: `super-admin-app`'s own suite (88 passed), `ng lint`
clean, `ng build` clean.

**Named, not fixed**: `KybQueueListView`/`KybQueueSerializer`/
`KybQueueStore` (frontend) left in place on the backend despite no
current frontend caller — removing a still-correct, still-tested
endpoint on the strength of "nothing calls it from this app today" was
judged riskier than the small unused-surface cost of leaving it, since
some other, unaudited caller was not fully ruled out. Worth a follow-up
grep-and-remove if that's confirmed later, not done as part of this
merge.

**Next**: nothing scheduled.
