# 11-KYB-Directors: Structured directors and a real KYB form

## Scope and non-goals

Today a client-admin submits KYB by scrolling past the business edit
form to an appended block containing one document-type `<select>` and
one file input (`business-form.html`, the `@if (editing())` section).
Every required document goes through that same undifferentiated
control, one at a time, with no indication of what is needed, what has
already been supplied, or what a valid document looks like. Director
identity — which is the substance of a KYB check — has nowhere to live
at all.

**In scope:**

- A `Director` model, so a Business's directors are structured records
  rather than a pile of same-looking uploads.
- A dedicated KYB screen with labelled sections per document type and
  real guidance text.
- Directors surfaced in the super-admin KYB review queue.

**Non-goals:**

- Automated verification, OCR, or any third-party KYB/identity
  provider. This is data capture and human review, exactly as
  `clients.KycDocument` already works.
- Changing when `kyb_status` transitions. `submit_kyb_document`'s
  existing rule (any upload while `pending` or `rejected` moves it to
  `submitted`; an upload after approval adds the document and changes
  nothing) is preserved unchanged.
- Making any document mandatory. Sufficiency is a review-time judgment
  by platform staff, not a form constraint — an operator part-way
  through gathering paperwork must still be able to save progress.

## Data model changes

### New: `businesses.Director`

Inherits `core.models.BaseModel`, so it is tenant-scoped and
RLS-protected. Its migration **must** apply
`apps.core.migration_operations.EnableRowLevelSecurity("director")` —
a registry-driven test (`apps/core/tests/test_row_level_security.py`)
enforces this with no allowlist, so omitting it fails the suite.

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `Business`, `on_delete=PROTECT`, `related_name="+"` | `related_name="+"` deliberately, per `KybDocument`'s own precedent: a reverse accessor would route through `TenantScopedManager` and silently empty for platform staff |
| `full_name` | `CharField(255)` | |
| `id_type` | `CharField(30, choices=IdType)` | |
| `id_number` | `CharField(50, blank=True)` | Optional — an operator may be filling this in before they have the document to hand |
| `is_active` | `BooleanField(default=True)` | Soft-remove; see edge cases |

```python
class IdType(models.TextChoices):
    NIN             = "nin",             "National Identification Number (NIN)"
    PASSPORT        = "passport",        "International passport"
    DRIVERS_LICENCE = "drivers_licence", "Driver's licence"
    VOTERS_CARD     = "voters_card",     "Voter's card"
```

`Meta.ordering = ["full_name"]` — stated explicitly, not inherited.
`identity.Role` and `identity.User` both silently dropped
`BaseModel.Meta`'s ordering by declaring a bare `Meta`, which produced
real unstable-pagination bugs; `Route.Meta`'s own comment documents the
same trap. Declaring it here costs nothing and closes it.

A Business may have several directors — that is the whole reason this
is its own model rather than a pair of fields on `Business`. Nigerian
CAC filings routinely list two or more, and a single-director
assumption would need unpicking almost immediately.

### Changed: `businesses.KybDocument`

Additive nullable FK:

```python
director = models.ForeignKey(
    Director, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
)
```

A director's ID document points at its director. Company-level
documents — certificate of incorporation, proof of address, tax
certificate, other — leave it null. `PROTECT` rather than `CASCADE` is
what makes the soft-remove rule below enforceable rather than advisory.

Both changes are **additive**. No destructive migration, no backfill,
no approval gate.

## API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/businesses/{business_id}/directors/` | `client.view` | Paginated, ordered by name |
| `POST` | `/businesses/{business_id}/directors/` | `business.manage` | |
| `PATCH` | `/directors/{id}/` | `business.manage` | Including `is_active` |
| `POST` | `/businesses/{business_id}/kyb-documents/` | `kyb.submit` | Gains an optional `director` field |

No new permission codenames. Note the read gate is **`client.view`**,
not `business.view` — there is no such codename. `apps/businesses` has
only a write codename (`business.manage`); reads on
`BusinessListCreateView` branch per-method to `client.view`, and this
spec follows that established pairing exactly rather than inventing a
read permission for one nested resource. `client.view`,
`business.manage` and `kyb.submit` are all already granted to the Role
presets, so no seeding migration is needed.

Writes go through a service function
(`apps.businesses.services.create_director` / `update_director`),
not the serializer, per this repo's fat-services convention — and each
records an audit event via `record_audit_event`, matching every other
write in `apps/businesses/services.py`.

**Two DRF traps that apply directly here**, both already documented in
CLAUDE.md and both easy to walk into on this slice:

- Never write `queryset = Director.objects.all()` as a bare class
  attribute on a view. It is evaluated once at import time, before any
  request has set a tenancy context, and freezes to an empty queryset
  forever. Override `get_queryset()` as a method.
- Never write `PrimaryKeyRelatedField(queryset=Director.objects.all())`
  on the `KybDocument` serializer for the new `director` field —
  declared serializer fields are collected at class-body execution time
  and hit the same trap. Resolve the FK inside `validate_director()`
  instead.

### Review queue

`BusinessKybQueueSerializer` gains an embedded `directors` list, so a
platform-staff reviewer can see who they are approving rather than
inferring it from filenames.

Batch the fetch. That serializer's existing `get_documents` carries a
comment about the exact N+1 this would otherwise reintroduce (found in
the Phase 1 self-check's query-count audit) and reads through
`Director.all_objects`, not `.objects`, for the same reason it already
does for documents: the caller is platform staff with `client_id=None`
in their JWT, and the tenant-scoped manager would short-circuit to
empty.

## Form design

One screen at `businesses/{id}/kyb` in `client-admin-app`, replacing
the block currently appended to the business edit form. Sections, in
order:

1. **Directors** — repeatable rows: full name, ID type, ID number
   (optional), ID document upload. Add and remove.
2. **Certificate of incorporation** — single upload.
3. **Proof of address** — single upload.
4. **Tax certificate** — single upload.
5. **Other supporting documents** — repeatable, free-labelled.

Each section shows what has already been uploaded, so an operator
returning to the screen can tell what is outstanding — which the
current UI cannot express at all.

### Guidance text

**Proof of address** — a utility bill, bank statement, or tenancy
agreement dated within the last 3 months, showing the business name and
address.

**Director's ID**, per type: NIN slip or NIMC card; the data page of an
international passport; a current driver's licence; or a voter's card.
The document must be in date and the name must match the director's
name as entered.

> `ASSUMPTION:` the original request listed "*Include what counts as
> valid proof of address*" under **both** "Director's ID type" and
> "Proof of Address". This spec reads the first as a copy-paste and
> gives the ID-type field ID guidance, not address guidance. If the
> intent was genuinely to repeat address guidance there, this section
> is what changes.

## Edge cases

- **Director ID uploaded with no director selected** → 400. A director
  ID that points at nobody is worse than a rejected upload; it looks
  filed but proves nothing.
- **Director removed while holding documents** → soft-remove via
  `is_active=false`. Never cascade. `on_delete=PROTECT` means a hard
  delete raises rather than silently destroying evidence attached to a
  submitted or already-approved KYB packet.
- **Upload after approval** → the document is added; `kyb_status` is
  untouched. Existing `submit_kyb_document` behaviour, preserved.
- **Business with zero directors submits** → allowed. Platform staff
  decide sufficiency at review; the form does not gatekeep.
- **Director belonging to another Client** referenced by id → 404 via
  the tenant-scoped manager, never a cross-tenant read.
- **Same person listed twice** → allowed. No uniqueness on
  `(business, full_name)`; real filings contain duplicates and
  near-duplicates, and a constraint here would block legitimate saves
  for no safety gain.

## Failure modes

- **Upload succeeds, director create fails** (or vice versa) in the
  repeatable director row: the frontend creates the `Director` first,
  then uploads its document referencing the returned id. A failed
  upload therefore leaves a director with no document — visible and
  fixable — rather than an orphaned file.
- **File storage unavailable** — unchanged from today: uploads go to
  local disk (`MEDIA_ROOT`), and production S3 storage remains
  documented-but-unbuilt. This slice does not change that, and should
  not be read as having addressed it.
- **Concurrent edits to the same business's directors** — last write
  wins per director row. No lock; there is no invariant across
  directors to protect.

## Test plan

**Backend.** Director create/list/patch; the mandatory cross-client
isolation test (a Client must not read or patch another Client's
directors, both through the ORM and with RLS as the second layer); the
RLS-registry test passing for the new model; document→director linking,
including the no-director-selected 400; `PROTECT` raising on a hard
delete of a director with documents; the KYB queue's embedded directors
with an explicit query-count assertion so the N+1 cannot creep back.

**Frontend.** The new screen's repeatable director rows (add, remove,
validation), upload wiring per section, and already-uploaded state
rendering.

**E2E.** Extend `frontend/e2e/` `kyb-queue.spec.ts` so the reviewer
flow sees a director. Note the standing caveat: that spec is one of two
currently affected by accumulated dev-database cruft with protected
dependents that `prune_e2e_test_data` cannot safely remove.

## Migration impact

Two additive migrations in `apps/businesses`:

1. `CreateModel(Director)` **plus**
   `EnableRowLevelSecurity("director")` in the same migration.
2. `AddField(KybDocument.director)` — nullable, no default needed.

Both are safe and reversible. Nothing is destructive; no explicit
approval gate applies.

## Implementation note (done, 2026-08-26)

Built backend-then-frontend, then self-checked in full —
`docs/self-check-2026-08-26-spec11.md` and
`docs/ui-review/11-kyb-directors/`.

**The self-check is the part worth reading.** This spec was first
reported complete on test-suite results alone, without §10.6's visual
loop, without §10.7's report, and without ever running Playwright
against `super-admin-app` even though this slice modified its KYB
queue. Running those afterwards found two High-severity defects the
unit and e2e suites had both passed over, and left the super-admin
suite going from 6 passed / 2 failed / 7 not-run to 16/16.

### What the spec did not anticipate

- **`Ticket`-style modelling call, made before any code shipped**: the
  spec's first draft hung KYB documents off nothing in particular. A
  `Director` needed `related_name="+"`, per `KybDocument`'s own
  precedent — a reverse accessor routes through `TenantScopedManager`
  and silently empties for platform staff, who are exactly the people
  reading a review queue.
- **`KybDocumentUploadView` was POST-only.** The spec requires showing
  what has already been supplied, which nothing could do. Added `GET`
  — with `pagination_class = None`, or drf-spectacular documents the
  bare list as a `{count, results}` envelope and the generated
  `schema.ts` stops matching what the endpoint returns. Same fix
  `VehicleTypeSeatsView` already uses.
- **The serializer returned a name where the schema promised a UUID.**
  A declared `UUIDField` serialized the related `Director` *instance*
  through `str()`, hitting `Director.__str__`, so
  `{"director": "Bola Adeyemi"}` went over the wire. Found only by a
  live HTTP round-trip: the unit tests asserted `document.director_id`
  on the model and never looked at the payload. Fixed with an explicit
  `to_representation`, plus a response-level assertion.
- **`ui-button` had no `ariaLabel`.** This screen has six buttons named
  "Upload". Binding `aria-label` on `<ui-button>` lands on the
  `display: contents` host and is silently dropped — the same trap the
  component's own `ariaPressed` passthrough already documents.
- **Both review queues were ordered by creation, not submission**, so a
  business registered months ago but submitted this morning sorted
  below everything created after it. Now `order_by("kyb_submitted_at")`
  / `("kyc_submitted_at")` — oldest submission first. Applied to the
  KYC queue too: identical defect, and the two are the same screen for
  two models.

### The two High-severity defects §10.6 found

1. **The screen could not open a business past row 25.** It resolved
   from `BusinessStore`'s loaded page and fell through to "That
   business couldn't be found" — against 77 businesses, everything from
   index 25 on, including real non-fixture data at index 32. Copied
   from `business-form.ts`, whose docstring recorded the behaviour as
   an accepted limitation. Third instance of the family CLAUDE.md
   already records fixing twice. Fixed with `BusinessStore.findById()`.

   Earlier live verification missed it entirely because it used a
   freshly created business, which always sorts onto page 1.

2. **The add-director form gave no validation feedback at all.**
   `ui-text-field`/`ui-select` render an error only when the parent
   binds `[invalid]` and `[errorMessage]`; this template bound neither.
   The covering unit test asserted only that `POST` was not called —
   the model, never the rendered output — so it passed throughout.

### Known open, reported not fixed

- Six more `client-admin-app` edit forms share defect 1's bounded-page
  lookup (`driver-form`, `vehicle-type-form`, `schedule-form`,
  `stop-form`, `vehicle-form`, `route-form`).
- The KYB queue has no search — 36 near-identical rows, 25 per page.
- `prune_e2e_test_data` cannot clear the review queues at all
  (`KybDocument.business` is `PROTECT`), so they grow with every e2e
  run; `kyb-queue.spec.ts` now pages to its fixture.
- An approved business still renders every document as `pending`.
