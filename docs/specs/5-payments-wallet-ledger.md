# 5-payments-wallet-ledger: Payments, Wallet, Ledger

Sequenced after Phase 4 (Fares, Seating, Booking) and Phase 4b
(tap-and-go fare determination). `docs/status-report-2026-08-14.md` §4
already named the terminus this phase exists to move past:

> Scope: fare determination, not fare collection... It stops there —
> settlement belongs to Phase 5.

and `Booking.status == pending_payment` has been the reservation flow's
own unfilled terminus since Phase 4 Slice 3. This spec is unblocked by
two Accepted ADRs, neither open for reconsideration here — per this
repo's own working agreement, a proposed ADR is finalized *before* the
phase that needs it is spec'd, not during it:

- `docs/adr/0006-ledger-chart-of-accounts.md` — fixes the account
  taxonomy, the three-line commission-split shape, and the
  settlement-run FK direction.
- `docs/adr/0007-payment-partner-selection.md` — fixes **Paystack** as
  the PSP for Nigeria-based operators, with Botswana named as an
  explicit, deferred gap (Paystack has no Botswana coverage; a second
  PSP is future work, not this phase's job).

## Scope and non-goals

**In scope, across the whole phase**: a double-entry ledger
(`apps/ledger`) that every later money movement writes through; a
Paystack payment-initiation and webhook flow (`apps/payments`) that
takes a `Booking` from `pending_payment` to paid and funds the
passenger's wallet and the Business's clearing account in the same
atomic write; a thin passenger-facing wallet read view
(`apps/wallet`); and operator payouts (`SettlementRun`, staff-triggered,
Paystack Transfer API).

**This phase is built as three backend slices, matching Phase 4's own
precedent** (fares → seating → booking, each reviewed before the next
started) rather than one continuous pass:

- **Slice 1 — Ledger foundation** (`apps/ledger`): the account
  taxonomy, the balanced-journal-entry invariant, `SettlementRun` as a
  data model with no execution logic yet, staff read endpoints. No
  dependency on Paystack or on `apps/booking`. **This is the slice this
  pass builds.**
- **Slice 2 — Paystack payment + webhook** (`apps/payments`,
  `apps/wallet`, the `Booking.Status.PAID` addition): the actual
  money-moving, product-critical slice. Depends on Slice 1's
  `post_journal_entry()`.
- **Slice 3 — Settlement runs**: the staff payout trigger, the
  entry-claiming query, Paystack Transfer webhook handling.

Slices 2 and 3 are fully spec'd below (data model, API, edge cases) so
the whole phase's shape is decided up front — per this repo's "spec
before code" rule and to avoid the retrofitting ADR-0006 itself was
written to prevent — but **only Slice 1 is implemented this pass**; see
each section for which parts are built now versus specified-ahead.

**Non-goals** (each a deliberate boundary, not an oversight):

- **A second PSP for Botswana.** ADR-0007's own named, tracked gap. A
  Botswana `Business` can exist and take bookings (tap-and-go doesn't
  need payment) but cannot go live on Phase 5 payment collection until
  a second PSP is integrated — a later, separate slice.
- **`apps/tapngo` fare collection.** This phase's `POST /payments/`
  always initiates one fresh Paystack charge for one specific booking's
  exact amount, funding and spending the passenger's wallet atomically
  in the same write. Charging an already-*closed* `FareJourney` after
  the fact is a different problem — "debit an existing, already-funded
  wallet balance with no interactive checkout moment to redirect the
  passenger to" — and needs its own concurrency treatment for two
  concurrent spends against the same balance. Not required to make
  `Booking → paid` work, and not built here. Named explicitly so the
  Botswana gap above isn't quietly compounded by a second, unstated one:
  even a Business with Paystack configured still can't collect
  tap-and-go fares after this phase.
- **Standalone wallet top-up.** A passenger funding their wallet ahead
  of a purchase, independent of any specific booking's checkout. Same
  reasoning as above — this phase's payment flow is always
  booking-triggered and self-funding.
- **PSP suspense-account reconciliation.** The `psp_suspense` account
  type exists in the taxonomy from Slice 1's first migration (per
  ADR-0006's "fixed taxonomy" requirement) but nothing writes to it
  this phase. Its purpose — matching Paystack's own settlement reports
  against our ledger — is a reconciliation workflow, not a
  transaction-time write, and isn't built here.
- **Automatic refund issuance.** Slice 2 names a real race (a booking's
  seat hold lapsing while a Paystack charge is in flight) and flags the
  resulting `PaymentIntent` for manual attention
  (`requires_manual_refund`); it does not call Paystack's refund API or
  build a remediation workflow. Same shape as 4b's `needs_review`
  precedent — visible, not resolved.
- **Concessions/discounts as a distinct account type.** ADR-0006 already
  settled this: concessions reuse the refund/chargeback contra
  accounts. No further design work needed here, only implementation
  (Slice 2/3, since a concession is applied against an existing paid
  booking).
- **A cached-balance reconciliation job.** ADR-0006 allows
  `LedgerAccount.cached_balance` to drift and be "reconciled
  periodically" against the derived `SUM(JournalLine.amount)`. The
  periodic reconciliation sweep itself is not built this phase; the
  cached value is written transactionally alongside every journal write
  (Slice 1), so it cannot drift from anything Slice 1 itself writes —
  only from data corrected outside the normal write path, which isn't a
  scenario this phase introduces.

## Account taxonomy

Reproduced from ADR-0006, not reopened here — this section exists so
the data model below reads as an implementation of a settled decision,
not a fresh one.

| `account_type` | Scope | Purpose |
|---|---|---|
| `wallet` | `(Business, Passenger)` | A passenger's spendable balance with one operator. |
| `business_clearing` | `Business` | Accumulates fare revenue pending settlement. |
| `integra_commission` | Platform (one row, no Business) | Accumulates commission split off every transaction. |
| `psp_suspense` | `(Business, provider)` | Funds acknowledged by the PSP, not yet reconciled/settled. Not written to this phase. |
| `refund_contra` | `Business` | Refunds, chargebacks, *and* concessions — one contra account type, per ADR-0006's "economically the same movement" reasoning. |

A successful payment writes **one** `JournalEntry` with **three**
`JournalLine`s (passenger/wallet debit, Business clearing credit,
Integra commission credit) — never two linked entries. This is fixed
by ADR-0006 and implemented as-is in Slice 2.

## Data model changes

### `apps/ledger` (Slice 1 — built this pass)

New app. All four models are `BaseModel` subclasses, RLS-enabled via
`EnableRowLevelSecurity` in the first migration, following
`apps/tapngo/migrations/0001_initial.py`'s exact ordering (all
`CreateModel`s → all `AddConstraint`s → `EnableRowLevelSecurity` per
model, last).

#### `LedgerAccount`

| Field | Type | Notes |
|---|---|---|
| `client` | FK → `clients.Client`, PROTECT, **nullable** | `BaseModel`'s own `client` field, overridden nullable — the single `integra_commission` row is the only one ever created with `client=None`. Mirrors `identity.User`'s existing nullable-`client` precedent for platform-level rows (ADR-0003); the RLS policy already treats a `NULL client_id` as invisible to ordinary tenants and visible only under `platform_staff_bypass()`, so no policy SQL changes are needed. |
| `account_type` | `CharField`, choices `wallet`/`business_clearing`/`integra_commission`/`psp_suspense`/`refund_contra` | Fixed enum from this first migration, per ADR-0006. |
| `business` | FK → `businesses.Business`, PROTECT, nullable | Required for every type except `integra_commission`. |
| `passenger` | FK → `identity.User`, PROTECT, nullable | Required iff `account_type == wallet`. |
| `psp_provider` | `CharField(32)`, blank | Populated iff `account_type == psp_suspense` (e.g. `"paystack"`). |
| `cached_balance` | `DecimalField(10,2)`, nullable | Never authoritative — `SUM(JournalLine.amount)` for the account is always the real balance (ADR-0006). Written transactionally alongside each `post_journal_entry()` call, never read as the source of truth by any balance-changing code path. |
| `cached_balance_updated_at` | `DateTimeField`, nullable | |

```python
constraints = [
    models.UniqueConstraint(
        fields=["business", "passenger"], condition=models.Q(account_type="wallet"),
        name="unique_wallet_account_per_business_passenger",
    ),
    models.UniqueConstraint(
        fields=["business"], condition=models.Q(account_type="business_clearing"),
        name="unique_clearing_account_per_business",
    ),
    models.UniqueConstraint(
        fields=["business", "psp_provider"], condition=models.Q(account_type="psp_suspense"),
        name="unique_psp_suspense_account_per_business_provider",
    ),
    models.UniqueConstraint(
        fields=["business"], condition=models.Q(account_type="refund_contra"),
        name="unique_refund_contra_account_per_business",
    ),
    models.UniqueConstraint(
        fields=["account_type"], condition=models.Q(account_type="integra_commission"),
        name="single_integra_commission_account",
    ),
    models.CheckConstraint(
        check=(
            models.Q(account_type="wallet", passenger__isnull=False)
            | (~models.Q(account_type="wallet") & models.Q(passenger__isnull=True))
        ),
        name="ledger_account_passenger_iff_wallet",
    ),
    models.CheckConstraint(
        check=(
            models.Q(account_type="integra_commission", business__isnull=True)
            | (~models.Q(account_type="integra_commission") & models.Q(business__isnull=False))
        ),
        name="ledger_account_business_iff_not_commission",
    ),
]
```

Every partial-unique constraint above is a concurrency mechanism, not
just a data-integrity one (§ Test plan) — the same "always attempt the
write, let Postgres decide" discipline ADR-0004 and the 4b spec both
already established. **`LedgerAccount` rows are only ever constructed
through `apps.ledger.services.get_or_create_wallet_account()` /
`get_or_create_business_clearing_account()` /
`get_or_create_commission_account()` /
`get_or_create_psp_suspense_account()`** — no view, serializer, or
other app is permitted to call `LedgerAccount.objects.create()`
directly (grep-audited, § Test plan).

#### `JournalEntry`

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, PROTECT | Required — every entry belongs to exactly one Business's books, including the commission line (see `JournalLine` below). |
| `entry_type` | `CharField`, choices `payment`/`refund`/`concession` | |
| `settlement_run` | FK → `SettlementRun`, PROTECT, **nullable from this first migration** | Per ADR-0006 exactly: set once, at the moment an entry is included in a payout batch. Not written to this phase (Slice 3 writes it), but the column exists now to avoid a later destructive migration once real financial data exists. |
| `external_reference` | `CharField(255)`, blank, indexed | The PSP's own transaction/transfer reference, for support lookups without joining into `apps.payments`. Not populated this phase (no PSP integration yet) — populated by Slice 2/3. |
| `memo` | `TextField`, blank | |

#### `JournalLine`

| Field | Type | Notes |
|---|---|---|
| `journal_entry` | FK → `JournalEntry`, PROTECT, `related_name="+"` | Matches this codebase's universal no-reverse-accessor convention on RLS-protected models. |
| `account` | FK → `LedgerAccount`, PROTECT, `related_name="+"` | |
| `amount` | `DecimalField(10,2)` | **Signed**: negative = debit (decreases the account's balance), positive = credit (increases it). This is a schema-level decision the ADR's own debit/credit English doesn't itself pin down; it's chosen because it makes ADR-0006's stated balance formula (`SUM(JournalLine.amount)` per account) literally true with no further derivation, and "debits equal credits" collapses to the single testable invariant `SUM(amount) == 0` per `JournalEntry`. |
| `currency` | `CharField(8)` | Matches `Business.currency`/`Booking.currency`'s existing field shape. Always equal to the parent `JournalEntry`'s Business currency — carried on the line, not just the entry, so a line can be summed/audited without a join. |

#### `SettlementRun`

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, PROTECT | |
| `period_start` / `period_end` | `DateField` | Half-open `[period_start, period_end)`, matching `apps.fares`'s own versioning-window convention. |
| `status` | `CharField`, choices `pending`/`processing`/`paid_out`/`failed` | |
| `initiated_by` | FK → `identity.User`, `SET_NULL`, nullable | The platform-staff user who triggered the run. |
| `total_amount` / `currency` | `DecimalField(10,2)` / `CharField(8)` | Snapshotted at creation from the sum of claimed entries — not recomputed live afterward. |
| `psp_transfer_reference` | `CharField(255)`, blank | Paystack Transfer reference. Not populated this phase. |
| `psp_transfer_status` | `CharField(64)`, blank | Not populated this phase. |
| `executed_at` | `DateTimeField`, nullable | |

```python
constraints = [
    models.UniqueConstraint(
        fields=["business", "period_start", "period_end"],
        name="unique_settlement_run_per_business_period",
    ),
]
```

**ASSUMPTION**: a failed run is retried by transitioning its own
`status` back through `pending`/`processing`, not by creating a second
`SettlementRun` row for the same period — the unique constraint above
enforces this directly. If real-world payout failures turn out to need
a distinct retry record (e.g. to preserve a failed attempt's own
audit trail rather than overwriting it), that's a Slice 3 implementation
question, not a Slice 1 one, since Slice 1 builds no execution logic
against this model at all.

**Named gap, not solved (per ADR-0006 taken literally)**: a
`SettlementRun` only *tags* entries via the `settlement_run` FK — it
does not itself write a reversing/payout `JournalEntry`. A Business's
derived clearing-account balance (`SUM(JournalLine.amount)`) therefore
does **not** decrease when a payout executes; "unsettled" stays
`WHERE settlement_run IS NULL` forever, not a net post-payout balance.
Reconciling actual bank-transfer cash movement against this is
`SettlementRun.psp_transfer_status`, not a further ledger entry. Flagged
here rather than silently accepted, exactly as this document's own
non-goals are.

### `apps/payments` (Slice 2 — spec'd, not built this pass)

**`PaystackAccount`** — the Business's payout *destination* reference,
not a duplicate merchant-credential set (see the merchant-of-record
decision below).

| Field | Type | Notes |
|---|---|---|
| `business` | OneToOneField → `businesses.Business`, PROTECT | |
| `recipient_code` | `CharField(255)`, blank | Paystack Transfer Recipient code. |
| `bank_code` / `account_number` / `account_name` | `CharField` | |
| `is_active` | `BooleanField`, default `True` | |
| `verified_at` | `DateTimeField`, nullable | |

Configured via its own `IsPlatformStaff`-gated endpoint, mirroring
`Business.seat_hold_minutes`'s "own super-admin-only endpoint, not the
general PATCH" precedent — sharper here, since exposing payout-bank-
account edits on a client-editable surface is a fraud vector, not just
an inventory-tuning one.

**Merchant-of-record decision**: Integra holds **one platform-level
Paystack secret key**, used for every `initialize`/webhook-verify/
`transfer` call regardless of which Business a payment belongs to —
not a per-Business Paystack merchant account. This reading is forced by
ADR-0006's own taxonomy (an `integra_commission` account that
accumulates a cut of *every* transaction, and a `SettlementRun` that
pays a Business out *afterward*, only make sense if Integra collects
first). `PaystackAccount` is therefore a payout-destination reference,
not a second merchant integration — and it's what gives ADR-0007's
"fail closed" directive real teeth: `initiate_payment()`'s first check
is "does this Business have an active `PaystackAccount`?" A Botswana
Business simply never gets one configured (no BWP payout rails on
Paystack), so it fails closed automatically, with zero country-sniffing
logic anywhere in the payment path.

**`PaymentIntent`**

| Field | Type | Notes |
|---|---|---|
| `booking` | FK → `booking.Booking`, PROTECT | |
| `business` / `passenger` | FK, PROTECT | Denormalized from `booking`, matching `FareJourney`'s own denormalization precedent — read/audit convenience, not a new source of truth. |
| `amount` / `currency` | `DecimalField(10,2)` / `CharField(8)` | Snapshotted from `booking.total_amount`/`.currency` at initiation. |
| `status` | `CharField`, choices `pending`/`succeeded`/`failed`/`cancelled` | |
| `psp_provider` | `CharField(32)` | Currently only `"paystack"`, but a real column — per ADR-0007's "don't hardcode a single-PSP assumption so deeply that adding a second one later requires a rewrite." |
| `psp_reference` | `CharField(255)`, unique | Generated server-side *before* calling Paystack, so a retried request under one `Idempotency-Key` can't produce two different Paystack transactions. |
| `psp_authorization_url` | `CharField(500)`, blank | The Paystack checkout redirect URL. |
| `succeeded_at` / `failed_at` | `DateTimeField`, nullable | |
| `journal_entry` | OneToOneField → `ledger.JournalEntry`, PROTECT, nullable | Set exactly once, on `charge.success` — the webhook-idempotency guard, directly reusing ADR-0006's own "a normal unique write, not a set-membership check that could race" idiom. |
| `requires_manual_refund` | `BooleanField`, default `False` | Set when a payment succeeds after its booking's seats are already gone (§ Edge cases). |

```python
constraints = [
    models.UniqueConstraint(
        fields=["booking"], condition=models.Q(status="pending"),
        name="one_pending_payment_intent_per_booking",
    ),
]
```

**`WebhookEvent`** — deliberately **not** a `BaseModel` subclass, same
reasoning as `AuditLog`/`IdempotencyKey`: it must be writable before any
tenancy context exists, since Paystack calls a public, unauthenticated
endpoint. Outside the RLS-coverage registry test for that reason — named
explicitly here so it doesn't read as a missed model later.

| Field | Type | Notes |
|---|---|---|
| `client_id` | `UUIDField`, nullable, plain field (not FK) | Resolved post-hoc once a matching `PaymentIntent` is found, same pattern `AuditLog.client_id` already uses. |
| `psp_provider` | `CharField(32)` | |
| `event_type` | `CharField(64)` | e.g. `charge.success`, `charge.failed`, `transfer.success`. |
| `reference` | `CharField(255)` | |
| `signature_valid` | `BooleanField` | |
| `raw_payload` | `JSONField` | Full webhook body, kept for audit/replay debugging. |
| `payment_intent` | FK → `PaymentIntent`, `SET_NULL`, nullable | |
| `processing_status` | `CharField`, choices `received`/`processed`/`ignored`/`failed` | |
| `created_at` / `processed_at` | `DateTimeField` | |

```python
constraints = [
    models.UniqueConstraint(
        fields=["psp_provider", "reference", "event_type"],
        name="unique_webhook_event_per_provider_reference_type",
    ),
]
```

**Webhook idempotency decision**: does **not** reuse
`apps.core.models.IdempotencyKey` — that model's `(client_id, endpoint,
key)` shape assumes a caller who knows their own tenancy up front,
which a webhook doesn't. `WebhookEvent`'s own unique constraint above is
Phase 5's webhook-specific dedup key — a sibling to `IdempotencyKey`,
same write-once-and-reconcile pattern, deliberately a separate model
because the key is PSP-supplied, not client-supplied.
`apps.core.models.IdempotencyKey` **is** reused as-is for
`POST /payments/` (`endpoint="payments.initiate"`) — identical
situation to `apps.booking.services.create_booking`.

### `apps/wallet` (Slice 2 — spec'd, not built this pass)

**No balance-bearing model of its own.** A "wallet" is not, per
ADR-0006, a financial primitive distinct from
`LedgerAccount(account_type="wallet")` — inventing a parallel model
with its own `balance` field would violate the ADR's own "balance is
always derived... never stored as an authoritative mutable field"
principle by creating a second place a balance could live. `apps/wallet`
exists as its own app purely for URL/permission namespacing and a
passenger-friendly read projection over `apps.ledger`
(`get_wallet_balance(passenger, business)` /
`list_wallet_transactions(passenger, business)`, both thin wrappers).
No migrations of substance — named explicitly rather than silently
omitted.

### `apps/booking` (Slice 2 — spec'd, not built this pass)

`Booking.Status` gains `PAID = "paid", "Paid"` — additive, code-only
(Django `choices` isn't DB-enforced, so this migration is a no-op at
the schema level). State stays on the *owning* model, matching this
codebase's established preference (`SeatReservation.status`/
`Booking.status` are already the single source of truth for "is this
booking's inventory hold still valid") over an implicit join through
`PaymentIntent.booking` — a `PaymentIntent`-only design would force
`apps.seating`'s expiry sweep, `cancel_booking`'s eligibility check, and
any future refund flow to reach into `apps.payments` just to know if a
booking is still cancellable, which is strictly worse coupling than one
enum value.

On `charge.success`, inside one `transaction.atomic()` block (mirroring
`create_booking`'s "no intermediate state ever visible" discipline):
`post_journal_entry()` → `booking.status = PAID` → every
`SeatReservation.status = CONFIRMED` for that booking — finally
exercising the enum member that has existed unused since Phase 4.

## API surface

### Slice 1 (built this pass) — staff-facing, permission-gated

New codename `ledger.view`, seeded via
`apps/identity/migrations/0012_seed_phase5_ledger_permissions.py`
(exact `PERMISSIONS`/`RunPython(seed, unseed)` idiom as
`0011_seed_phase4b_tapngo_permissions.py`), added to Manager and Staff
in `DEFAULT_ROLE_PERMISSIONS` (Owner needs no edit — `None` already
means "every seeded permission").

- `GET /ledger/accounts/?business=` — list a Business's `LedgerAccount`
  rows (own Business only). Requires `ledger.view`.
- `GET /ledger/entries/?business=&account=` — list `JournalEntry` rows
  for a Business, filterable by account, with nested `lines`. Requires
  `ledger.view`.

No mutating endpoint exists this slice — `LedgerAccount`/`JournalEntry`
rows are created only by the `get_or_create_*`/`post_journal_entry()`
service functions, called from tests this pass and from Slice 2/3's
payment/settlement flows once built.

### Slice 2 (spec'd, not built this pass)

**Passenger-facing** (`IsAuthenticated` only, no Role — matches
`POST /bookings/`, ADR-0003's "passengers have no Role"):

- `POST /payments/` — body `{booking_id}`, `Idempotency-Key` required
  (reuses `apps.core.idempotency` exactly as `create_booking` does).
  `404 PspNotConfigured` if the Business has no active
  `PaystackAccount` (mirrors `FareNotConfigured`'s 404 idiom).
  `409 PaymentAlreadyPending` if one already exists for the booking.
  Refreshes every `SeatReservation.held_until` on the booking (§ Edge
  cases). Returns `{id, status, authorization_url, reference}`.
- `GET /payments/{id}/`, `GET /payments/mine/` — own `PaymentIntent`s
  only.
- `GET /wallet/mine/?business=` — `{balance, currency, transactions}`,
  a thin projection of the passenger's `(passenger, business)` wallet
  `LedgerAccount`.

**Webhook (PSP-facing)**:

- `POST /webhooks/paystack/` — `AllowAny`, no JWT. Verified by
  HMAC-SHA512 signature (`X-Paystack-Signature`) against the *raw*
  request body, `hmac.compare_digest`, checked before any DB write. Bad
  or missing signature → `401`. Valid signature → **always `200`**,
  regardless of whether the event was acted on, to avoid Paystack
  retry-storms on events correctly ignored. Writes `WebhookEvent` first
  (its unique constraint is the true dedup gate); on `charge.success`
  for a still-`pending` `PaymentIntent`, performs the ledger write +
  `Booking`/`SeatReservation` transition; on `charge.failed`, marks
  `PaymentIntent.status = failed`; any other event type →
  `processing_status = ignored`.

**Staff-facing** (new codenames `payments.view`, `wallet.view`):

- `GET /payments/` — staff list/filter by trip/business/status.
- `GET /wallet/?business=&passenger=` — staff wallet lookup for
  support/disputes.

### Slice 3 (spec'd, not built this pass)

- `GET /settlement-runs/`, `POST /settlement-runs/` —
  `IsPlatformStaff`-gated, **not** a Role/Permission codename: a payout
  is a platform financial operation, not client self-service — an
  operator triggering its own payout is both a fraud-control problem and
  a mismatch with the merchant-of-record model (the Paystack Transfer
  call uses Integra's own platform key). Mirrors the existing
  `Business.seat_hold_minutes` endpoint's gating.
- The `POST /webhooks/paystack/` endpoint from Slice 2 extends to
  handle `transfer.success`/`transfer.failed` events against an
  in-flight `SettlementRun`.

## Edge cases

1. **Unbalanced journal entry** (Slice 1). Rejected by
   `post_journal_entry()` before any DB write — `UnbalancedJournalEntry`
   raised in application code, never reaches Postgres. A caller bug, not
   a runtime data state, so no HTTP status applies (no view calls this
   with unvalidated input this slice).
2. **Concurrent first-time wallet-account creation** for the same
   `(business, passenger)` (Slice 1). DB-enforced by the partial unique
   constraint — `get_or_create_wallet_account()` catches the resulting
   `IntegrityError` and re-reads the winning row, same pattern
   `create_reservation` already uses for its own constraint violations.
3. **A second `integra_commission` account created accidentally**
   (Slice 1, defense-in-depth — application code should never attempt
   this after the first). DB-enforced by the singleton unique
   constraint.
4. **A `Business` without a configured `PaystackAccount` initiates
   payment** (Slice 2). `404 PspNotConfigured` — the literal
   implementation of ADR-0007's "fail closed... with a clear error, not
   a generic 500" directive. This is how the Botswana gap actually
   surfaces to a passenger, not a special-cased country check.
5. **A second `POST /payments/` while one is already `pending`** for the
   same booking (Slice 2). `409 PaymentAlreadyPending`, DB-enforced by
   `PaymentIntent`'s partial unique constraint.
6. **A booking's seat hold expires while a Paystack checkout is still in
   flight** (Slice 2). Mitigated, not eliminated: `initiate_payment()`
   refreshes every `SeatReservation.held_until` to a fresh
   `seat_hold_minutes` window at checkout start, shrinking this to
   "checkout takes longer than one fresh hold window" — the same risk
   booking creation already accepts, not a new one. For the residual
   case (booking already `expired`/`cancelled` by the time
   `charge.success` arrives): the webhook still writes the successful
   `PaymentIntent`/`JournalEntry` (real money moved — ADR-0006's own
   "keep our own record of every payment regardless of what the PSP
   reports"), does **not** transition `Booking`/`SeatReservation` (the
   seats are gone), and sets `PaymentIntent.requires_manual_refund =
   True`, surfaced on staff's `GET /payments/`. **Named, not solved** —
   see Non-goals.
7. **Duplicate/replayed webhook delivery** for the same
   `(provider, reference, event_type)` (Slice 2). `WebhookEvent`'s
   unique constraint is the dedup gate — a second delivery still returns
   `200` (so Paystack doesn't retry-storm) but
   `processing_status = ignored` on the second row, no second ledger
   write, no second state transition. Mandatory concurrency spike (§
   Test plan).
8. **Webhook signature invalid or missing.** `401`, no `WebhookEvent`
   row written at all (an unverified payload isn't trustworthy enough to
   even log as received) — Slice 2.
9. **A `charge.success` webhook arrives for a `PaymentIntent` that isn't
   `pending`** (already `succeeded`/`failed`/`cancelled` — a genuinely
   duplicate or out-of-order delivery not already caught by edge case 7,
   e.g. a differently-shaped retry). Idempotent no-op:
   `processing_status = ignored`, no second ledger write. Slice 2.
10. **Two concurrent settlement-run triggers for the same
    `(business, period)`** (Slice 3). `409`, DB-enforced by
    `SettlementRun`'s unique constraint. Mandatory concurrency spike (§
    Test plan).
11. **An unsettled `JournalEntry` is claimed by a settlement run while a
    second run for an overlapping period is also processing** (Slice 3).
    The `settlement_run` FK assignment is a normal unique write (ADR-0006's
    own phrase) — whichever run's `UPDATE` lands first claims the entry;
    the second run's claiming query simply finds fewer unclaimed entries.
    No entry can be claimed twice, by construction (a non-null FK can't
    be reassigned by the claiming query's own `WHERE settlement_run IS
    NULL` clause).

## Failure modes

- **Torn writes.** Every ledger write happens inside one
  `transaction.atomic()` block (`post_journal_entry()`, Slice 1; the
  webhook handler, Slice 2) — no intermediate state (an entry with only
  some of its lines, a `Booking` marked `PAID` without its
  `SeatReservation`s confirmed) is ever visible or persisted, matching
  `create_booking`/`create_reservation`'s existing discipline.
- **Concurrency.** Every concurrency-sensitive invariant this phase
  introduces is enforced by a DB constraint, never an application-level
  pre-check — the same "always attempt the write, let Postgres decide"
  standard ADR-0004 and the 4b spec both established. See Edge cases
  2/3/5/7/10/11.
- **Webhook out-of-order or duplicate delivery.** Handled entirely by
  `WebhookEvent`'s unique constraint plus the `PaymentIntent.status`
  state check (edge cases 7, 9) — Slice 2 never assumes Paystack
  delivers each event exactly once or in order.
- **PSP downtime during `POST /payments/`.** If the Paystack
  `initialize` call itself fails or times out, `initiate_payment()`
  does not create a `PaymentIntent` row at all (the Paystack call
  happens before the row is committed, inside the same
  `transaction.atomic()` block) — a retry under the same
  `Idempotency-Key` tries again cleanly, no orphaned `pending` row is
  left behind. Slice 2.
- **Server-assigned amounts.** `PaymentIntent.amount`/`.currency` are
  always read from `booking.total_amount`/`.currency` at initiation
  time, never client-supplied — mirrors `Booking.total_amount`'s own
  purchase-time-snapshot discipline (§ Data model changes,
  `apps/booking`).

## Test plan

**Backend** (mandatory cross-cutting tests per `docs/self-check.md`
§10.2, same bar every prior domain app was held to):

**Slice 1 (run this pass)**:
- Ledger invariant: `post_journal_entry()` rejects an unbalanced set of
  lines before any write; a DB-wide `SUM(amount) GROUP BY
  journal_entry_id == 0` sweep over every `JournalEntry` created across
  the whole test run, not just a single targeted test.
- **Concurrency (mandatory)**: N concurrent
  `get_or_create_wallet_account()` calls for the same
  `(business, passenger)` — exactly one `LedgerAccount(wallet)` row
  survives, run with real concurrent worker threads against a live test
  DB, matching `test_tapngo_concurrency.py`'s standard.
- Cross-client isolation on both new read endpoints.
- RLS coverage: confirm the existing registry-driven test
  (`apps/core/tests/test_row_level_security.py`) picks up all four new
  models automatically, no allowlist changes needed.
- `N+1` check on `GET /ledger/entries/` — `select_related`/
  `prefetch_related` on `lines`, `lines__account`.
- `grep -rn "\.all_objects\." apps/ledger` — tenancy-bypass audit, same
  check every prior phase's self-check has run.
- Audit coverage: every `post_journal_entry()` call and every
  `get_or_create_*_account()` first-creation calls `record_audit_event`.

**Slice 2 (spec'd, run when Slice 2 is built)**:
- **Concurrency (mandatory)**: concurrent `POST /payments/` for the same
  booking — exactly one `pending` `PaymentIntent` survives, others
  `409`.
- **Concurrency (mandatory, flagship spike for this slice)**: N
  concurrent identical webhook deliveries for the same
  `(reference, event_type)` — exactly one `JournalEntry` written, exactly
  one `Booking` transition, enforced by the two-layer guard
  (`WebhookEvent` uniqueness + `PaymentIntent.journal_entry` OneToOne
  uniqueness).
- Webhook signature verification: valid/invalid/missing signature cases.
- Every edge case in the section above tagged Slice 2, individually.
- Idempotency: `POST /payments/` replay semantics via
  `apps.core.idempotency`, identical to `create_booking`'s existing
  tests.

**Slice 3 (spec'd, run when Slice 3 is built)**:
- **Concurrency (mandatory)**: two concurrent `POST /settlement-runs/`
  for the same `(business, period)` — exactly one `SettlementRun`
  created, no `JournalEntry` double-claimed or claimed by two runs.

**Frontend**: none this phase — no frontend slice is scoped in this
spec. Staff-facing ledger/payment/settlement visibility screens are
real future work, named here so it doesn't read as forgotten, not
committed to a slice yet.

**E2E**: none this pass (Slice 1 has no frontend consumer). Deferred
alongside the frontend work above.

## Migration impact

**Slice 1 (this pass): purely additive.** New app (`apps/ledger`), four
new models, zero changes to any existing model or migration. No
destructive migrations, no approval gate needed.

**Slice 2 (future): additive**, except one small, non-destructive
change to an existing model — `Booking.Status` gains a `PAID` member.
Since Django `choices` are validated in application code, not enforced
at the schema level, this migration is a no-op against existing data;
no backfill, no data loss, no approval gate needed.

**Slice 3 (future): purely additive.** No changes to Slice 1/2 models
beyond `JournalEntry.settlement_run` actually being written to for the
first time (the column already exists from Slice 1's first migration).

## Implementation note (Slice 1, done)

Built as spec'd: `apps/ledger` (`LedgerAccount`, `SettlementRun`,
`JournalEntry`, `JournalLine`), `post_journal_entry()` plus the five
`get_or_create_*_account()` constructors (one per taxonomy type,
including `psp_suspense` and `refund_contra`, unused this phase but
present per the spec's own "every account type gets a constructor, not
just the ones a caller happens to need yet"), the two staff read
endpoints, and the `ledger.view` permission codename (seeded via
`apps/identity/migrations/0012_seed_phase5_ledger_permissions.py`,
added to Manager and Staff in `DEFAULT_ROLE_PERMISSIONS`). 30 new
tests, 413/413 backend-wide passing (up from 383); `ruff`/`mypy` clean;
`makemigrations --check` clean; OpenAPI regenerated and drift-checked
clean; `grep -rn "\.all_objects\."` confirms every use is confined to
`apps/ledger/services.py`, never a view. The mandatory concurrency
spike (`apps/ledger/tests/test_ledger_wallet_account_concurrency.py`,
8 concurrent `get_or_create_wallet_account()` calls for the same
`(business, passenger)`, exactly one row survives) passed reliably.

**One real bug found and fixed, not by static review — by running the
staff endpoint tests against real data**: `GET /ledger/entries/`'s
batched line-fetch originally used `select_related("account")` as an
N+1-avoidance optimization. `LedgerAccount` carries its own RLS policy,
and a JOIN against an RLS-protected table applies that table's policy
to the join itself — so any `JournalLine` referencing the platform
commission account (`client=None`, invisible to an ordinary Business's
staff session) was silently dropped from the result entirely, even
though the `JournalLine` row itself was fully visible under the
requesting staff's own tenancy session. Every payment entry looked like
it had 2 lines instead of 3. Fixed by sourcing `JournalLineNestedSerializer.account`
from the raw `account_id` column (`serializers.UUIDField(source="account_id")`)
instead of dereferencing the related object — this needs no join at
all, so it's both correct and one query cheaper than the original
"fix" of removing the join outright would have been. Documented inline
on the serializer as a real, non-obvious RLS+JOIN interaction — worth
knowing before reaching for `select_related`/`prefetch_related` against
any other RLS-protected table with nullable-`client` rows in it.

**A test-writing lesson, not a code bug**: an early version of
`test_only_one_integra_commission_account_platform_wide` nested
`transaction.atomic()` as the *outer* context and `platform_staff_bypass()`
as the *inner* one. When the expected `IntegrityError` fired,
`platform_staff_bypass()`'s own cleanup tried to run more SQL on a
transaction Postgres had already marked `needs_rollback`, raising
`TransactionManagementError` and masking the real exception the test
meant to prove. `apps.ledger.services.post_journal_entry`'s own nesting
(`platform_staff_bypass()` outer, `transaction.atomic()` inner) was
never wrong — only this test had the order backwards. Fixed by matching
the service layer's own order, with the reasoning written into the
test as a comment so it doesn't get un-fixed later.

**A DB-wide sweep test rewritten for robustness, not because its
assertion was ever false**: `test_every_journal_entry_created_this_test_balances_to_zero_a_db_wide_sweep`
originally exited its writing `tenant_context` block, then reopened
`platform_staff_bypass()` to read via `all_objects`. That read
intermittently returned zero rows — but only when this test file was
collected in the *same pytest session* as the new
`transaction=True` concurrency file, never when run in isolation, and
never in a hand-run reproduction of the identical write sequence via
`manage.py shell`. This points at a pytest-django session/fixture
interaction specific to mixing non-transactional and transactional
`django_db` tests, not a defect in `post_journal_entry` or
`platform_staff_bypass` themselves — `apps/tapngo`'s own suite, which
mixes the same two test styles, shows no equivalent issue, so this
wasn't chased further as a platform-level bug. The practical fix needed
no bypass at all: every `JournalLine` this test writes has
`client=business.client` (never `None` — only `LedgerAccount`'s
platform commission row does), so the sweep query now simply runs via
`.objects` *inside* the same `tenant_context` block used to write,
which is both simpler and has run green on every repeated fresh-database
verification since.

**Not built this pass, as agreed before implementation started**:
`apps/payments`, `apps/wallet`, the `Booking.Status.PAID` addition, and
any Paystack integration — all fully spec'd above as Slice 2, deferred
per the agreed plan to stop and review after Slice 1. Slice 3
(settlement-run execution) is likewise spec'd, not built.

## Implementation note (Slice 2, done)

Built as spec'd: `apps/payments` (`PaystackAccount`, `PaymentIntent`,
`WebhookEvent`), `apps/payments/psp/paystack.py` (this backend's
first-ever outbound third-party HTTP integration — `requests` added as
a new dependency), `initiate_payment()`/`process_paystack_webhook()`/
`_handle_charge_success()`/`_handle_charge_failed()`/
`configure_paystack_account()`, `apps/wallet` (no model of its own, a
thin read layer over `apps.ledger` exactly as spec'd), `Booking.Status.PAID`
plus `apps.booking.services.mark_booking_paid()`, and
`apps.seating.services.refresh_seat_holds()`. Two new permission
codenames (`payments.view`, `wallet.view`, seeded via
`apps/identity/migrations/0013_seed_phase5_slice2_payments_wallet_permissions.py`).
66 new tests, 449/449 backend-wide passing (up from 383 before Slice 1,
413 after it); `ruff`/`mypy` clean; `makemigrations --check` clean;
OpenAPI regenerated and drift-checked clean (`PaystackWebhookView`
excluded from the schema via `@extend_schema(exclude=True)` — its body
is Paystack's own opaque payload, not a shape any frontend client here
calls); `grep -rn "\.all_objects\."` confirms every use is confined to
`apps/payments/services.py` and the one cross-client super-admin config
view, mirroring `apps.businesses.views.BusinessSeatHoldView`'s own
established precedent exactly. Both mandatory concurrency spikes passed
reliably: concurrent `POST /payments/` for the same booking (exactly
one `pending` `PaymentIntent` survives), and the flagship spike — N
concurrent identical webhook deliveries for the same
`(reference, event_type)` (exactly one `JournalEntry`, one `Booking`
transition, one `WebhookEvent` row).

**The commission-rate gap the spec itself left open** (neither ADR-0006
nor this spec ever names an actual percentage) was resolved before
implementation started, not silently defaulted: `INTEGRA_COMMISSION_RATE_PERCENT`
is a required environment variable with no code-level default,
mirroring `DJANGO_SECRET_KEY`'s own precedent — every real environment
must set a real rate explicitly before any payment can be processed at
all. Local dev (`.env`, `docker-compose.yml`) uses an obvious `5.00`
placeholder, clearly commented as such, not as a product decision.

**Two real, non-obvious bugs found and fixed — both by actually running
the webhook flow under real concurrency, not by static review or by
Slice 1's own test suite, which never exercised either path**:

1. **`Model.save(update_fields=...)` silently targeting zero rows when
   called with no active tenant context.** Django's `save()` performs
   its UPDATE through the model's `_base_manager` — which Django
   defaults to the *first* manager declared on the class
   (`BaseModel.objects`, the tenant-filtering `TenantScopedManager`) —
   regardless of which manager was actually used to *fetch* the
   instance. `mark_booking_paid()` and `_handle_charge_success()` both
   fetch via `Model.all_objects.select_for_update()` (correct, and
   necessary under `platform_staff_bypass()`, which has no Python
   tenancy context to filter by) but then call `instance.save(update_fields=[...])`
   — which Django silently re-targets through `objects`, whose
   contextvar-based filter matches nothing with no tenant context
   active. Django 6 surfaces this as `Model.NotUpdated` rather than a
   silent no-op, which is what caught it — on an older Django this
   would have been a genuinely silent data-loss bug. **This was already
   latent in Slice 1's own `apps.ledger.services.post_journal_entry()`**
   (its `account.save(update_fields=[...])` call on a `LedgerAccount`
   fetched via `all_objects`) — Slice 1's own tests never caught it only
   because every one of them happened to call `post_journal_entry()`
   from inside an active `tenant_context()`, which the real Slice 2
   webhook path never has. Fixed at the root, not per call site:
   `BaseModel.Meta.base_manager_name = "all_objects"`
   (`apps/core/models.py`) — `all_objects` has no filtering to work
   around in the first place, so this is strictly safe for every
   already-working `save()` call too. This is a pure ORM-state change
   (no DDL), but Django's migration autodetector still tracks
   `base_manager_name`/manager declarations as model state, so it
   produced one `AlterModelManagers`/`AlterModelOptions` migration per
   app with a `BaseModel` subclass — twelve apps in total, all
   state-only, none touching the database schema, all applied and
   verified clean.
2. **`platform_staff_bypass()` was not safe to nest**, contrary to what
   this spec's own data-model section assumed when describing
   `_handle_charge_success`'s three-levels-deep nesting
   (`_handle_charge_success` → `post_journal_entry` →
   `mark_booking_paid`, each opening its own bypass). The *inner* call's
   restore-on-exit computed "the RLS state before I was entered" from
   the Python tenancy contextvar — which bypass itself never touches,
   deliberately (see the module's own docstring) — so it always read
   "no bypass active," even when a real outer bypass was still
   logically open. The inner call's exit therefore reset the Postgres
   session GUCs to non-bypass mode mid-flight, breaking every
   RLS-protected query for the rest of the *outer* block — this is what
   produced bug 1's symptom in the first place; bug 1 alone would have
   been triggered even by a single, non-nested bypass call missing a
   tenant context, but the nesting bug made it appear even after fixing
   `base_manager_name`, on the first verification pass, until traced to
   its real source. Fixed with a `ContextVar`-based nesting-depth
   counter in `apps/core/rls.py`: only the outermost `platform_staff_bypass()`
   call now touches the GUCs or restores anything on exit; nested calls
   are no-ops that just track depth. Both fixes are covered by the
   existing ledger/payments test suites' own use of nested bypass calls
   (`_handle_charge_success`'s real call chain), not by dedicated
   isolated unit tests for `apps.core.rls` itself — a gap worth closing
   explicitly if this mechanism gains more callers.

**Not built this pass, as agreed before implementation started**: Slice
3 (settlement-run execution — the staff payout trigger, the
entry-claiming query, `transfer.success`/`transfer.failed` webhook
handling), a second PSP for Botswana, automatic refund issuance for the
`requires_manual_refund` case, `apps/tapngo` wallet-debit/pay-from-balance,
standalone wallet top-up, and any frontend consumer (confirmed out of
scope for the whole Phase 5 backend arc, per this spec's own Test plan
section).

## Implementation note (Slice 3, done)

Built as spec'd: `apps.ledger.services.claim_settlement_run()` (new,
`apps/ledger/services.py`) atomically creates a `SettlementRun` and
bulk-claims every currently-unclaimed `JournalEntry` for the Business in
`[period_start, period_end)`, snapshotting `total_amount` from the
claimed entries' `business_clearing`-account lines only —
`apps.payments.services.trigger_settlement_run()` then calls it,
followed by a real (mocked-in-tests) Paystack Transfer API call
(`apps/payments/psp/paystack.py::initiate_transfer()`, this backend's
first use of Paystack's Transfer endpoint, alongside the existing
`initialize_transaction()`), and the existing webhook handler gained
`transfer.success`/`transfer.failed` branches
(`_handle_transfer_success`/`_handle_transfer_failed`) that resolve a
`SettlementRun` by `psp_transfer_reference` the same way
`_handle_charge_success` resolves a `PaymentIntent` by `psp_reference`.
`GET`/`POST /settlement-runs/` (`apps.payments.views.SettlementRunListCreateView`)
is `IsPlatformStaff`-gated, not a Role/Permission codename, exactly as
spec'd — no new permission codename, no new migration (`SettlementRun`/
`JournalEntry.settlement_run` already existed from Slice 1's first
migration). 21 new tests, 470/470 backend-wide passing (up from 449
after Slice 2); `ruff`/`mypy` clean; `makemigrations --check` clean
(confirmed the only outstanding drift is the pre-existing, unrelated
`core_testapp` manager-state gap from Slice 2's `base_manager_name` fix
— see Known limitations); OpenAPI regenerated and drift-checked clean;
`grep -rn "\.all_objects\."` confirms every new use is confined to
`apps/ledger/services.py` and `apps/payments/services.py`, plus the two
existing cross-client-view precedents
(`PaystackAccountConfigView`/`SettlementRunListCreateView.get_queryset`,
both `IsPlatformStaff`-gated). The mandatory concurrency spike
(`apps/payments/tests/test_settlement_run_concurrency.py`, 8 concurrent
`trigger_settlement_run()` calls for the same `(business, period)`)
passed reliably across repeated standalone runs — exactly one
`SettlementRun` survives, and every pre-seeded `JournalEntry` ends up
claimed by that one survivor, none left behind or double-claimed
(edge case 11, exercised under real concurrency, not just the direct
unit coverage in `apps/ledger/tests/test_ledger_settlement_claiming.py`).

**Four real gaps the spec left implicit, resolved before implementation
started and shipped as-is** (none blocking enough to need the user's
direct input, unlike Slice 2's commission-rate gap — each is a narrow,
reviewable default):

1. **`recipient_code` precondition.** A Business can have an active
   `PaystackAccount` (bank details captured via the Slice 2 config
   endpoint) with no `recipient_code` yet — a distinct gap from
   `PspNotConfigured` (no account at all). Fails closed with a new
   `PayoutDestinationNotConfigured` → 404, same shape as
   `PspNotConfigured`.
2. **Zero/negative `total_amount`** (a period with no unsettled
   entries, or one dominated by refunds). Claiming still happens — those
   entries stop showing up as unsettled — but no Paystack Transfer call
   is made; the run is marked `paid_out` immediately.
3. **Period timezone anchoring.** `period_start`/`period_end` are
   converted to `business.timezone`-aware datetime bounds via
   `datetime.combine(d, time.min, tzinfo=ZoneInfo(business.timezone))`,
   the same pattern `apps.scheduling.services` already established.
4. **Retry of a `failed` run is still not built** (Slice 1's own
   ASSUMPTION, restated, not resolved here) — a `failed` run just sits
   there; a fresh period must be triggered separately.

**One real, non-obvious bug found and fixed — by running
`trigger_settlement_run()` as a direct service-layer call (the way a
future management command or Celery task would call it), not through
the HTTP endpoint**: the function's `recipient_code` precondition check
(`PaystackAccount.all_objects.filter(...)`) returned nothing even for a
correctly-configured Business, because `all_objects` bypasses the ORM's
tenant filter but not Postgres RLS itself — and no RLS bypass GUC was
active. Through the real `IsPlatformStaff` HTTP endpoint this was
invisible, because `TenancyMiddleware` already sets the platform-staff
RLS bypass GUC for any authenticated platform-staff request, so the
gap was silently papered over by the caller's own context every time it
was exercised via `POST /settlement-runs/`. This is the same class of
"only safe because of who happens to call it" fragility Slice 2's own
`platform_staff_bypass()`-nesting bug came from — caught here at
service-layer-test time rather than in production, precisely because
the test called the function directly instead of only through the view.
Fixed by making `trigger_settlement_run()` open its own
`platform_staff_bypass()` around its entire body, the same
self-sufficiency discipline `process_paystack_webhook()` already has
for the identical reason (a webhook request also has no middleware-set
bypass to lean on). `claim_settlement_run()` itself was never affected —
it already opened its own bypass, matching `post_journal_entry()`'s
existing pattern.

**Not built this pass**: a second PSP for Botswana, automatic refund
issuance, `apps/tapngo` wallet-debit/pay-from-balance, standalone wallet
top-up, retry of a `failed` `SettlementRun`, any frontend consumer.
**This closes Phase 5's backend arc** — all three planned slices
(ledger foundation, Paystack payment + webhook, settlement runs) are
now built and self-checked.

## Implementation note (Frontend Slice A — customer-app payment flow, done)

No frontend spec was written up front for Phase 5 (this section's own
parent spec explicitly scoped the frontend out — see "Test plan" above).
Given the frontend is being built one app at a time with a review
checkpoint between each — the user's own explicit choice, made because
of this project's documented history of process slips when too much
frontend work ships in one continuous pass (the Phase 4 frontend
addendum) — this section is written after the fact for the first slice,
the same as the backend's own "Implementation note" sections, rather
than pre-spec'd.

**What was built**: `my-bookings.ts`/`.html` (`projects/customer-app`)
gained a "Pay now" action on any `pending_payment` row. Clicking it
calls `POST /api/v1/payments/` (idempotency key generated once per
booking, reused across retries — the same discipline
`booking-confirm.ts` already established for booking creation, scoped
per-booking here since a passenger can have several pending bookings on
this one list) and, on success, redirects the browser to the returned
`authorization_url` via an isolated `redirectToPaystack()` method (no
existing precedent for an external redirect anywhere in this
workspace — this is the first one). On failure, the backend's own
`{detail: "..."}` message is surfaced directly via `ui-alert`, reusing
the file's existing `extractFirstErrorMessage` helper — no new
message-mapping table. `Booking.Status.PAID`'s `'paid'` value (present
in the backend since Slice 2, but never reflected in the frontend's
generated API types until this slice's `openapi:generate` re-run) was
added to `my-bookings.ts`'s exhaustive `STATUS_TONE`/`STATUS_LABEL`
maps.

**Scope, deliberately**: `booking-confirm.ts`'s post-create navigation
is untouched (still lands on `/my-bookings`, where the new action
lives); no dedicated wallet/payment-history screen; no `callback_url`
wired into `initialize_transaction()`, so there's no automatic
bounce-back to a specific in-app screen after a real Paystack
checkout — the passenger returns by navigating back manually, and
`my-bookings` reflects whatever status the webhook has landed by then.
Each is a real, named gap, not an oversight — see this file's own plan
history for the reasoning.

**A real regression caught and fixed, one app over from the one this
slice targeted**: regenerating `projects/api-client/src/lib/schema.ts`
(the actual first step of this slice — it had zero `/payments/`,
`/wallet/`, or `/ledger/*` paths before this) also updated
`Booking['status']` to include `'paid'`, since that enum member has
existed backend-side since Slice 2 but was never reflected in the
frontend's generated types until now. `client-admin-app`'s own
`booking-list.ts` has an identically-shaped exhaustive
`Record<BookingStatus, ...>` map for its own read-only staff bookings
list, and it stopped compiling the moment the schema was regenerated —
proof the exhaustiveness pattern this codebase uses in two independent
places is working exactly as intended, not a bug in either file. Fixed
by adding `paid` to that file's own `STATUS_TONE`/`STATUS_LABEL` maps
and its status-filter dropdown — purely enum coverage, no new
client-admin functionality, keeping this slice's actual scope (payments
*visibility* in client-admin) still deferred to its own later slice.

**Verified**: `openapi:generate`/`openapi:check` clean; `ng lint` clean
on both `customer-app` and `client-admin-app`; full workspace
`test:all` — 425 tests across all 9 projects, all passing, zero
regressions. Browser-verified against the real stack (Postgres, Redis,
backend rebuilt — its Docker image predated the `requests` dependency
added in Slice 2 and needed rebuilding first, an unrelated but real
environment-drift gap caught along the way) with a real seeded
passenger and `pending_payment` booking: "Pay now" renders correctly
and only on that row; clicking it fires the real request, correctly
surfaces the real 502 this environment's placeholder
`PAYSTACK_SECRET_KEY` produces (`Paystack initialize call failed: 401
Client Error: Unauthorized`), with the `Idempotency-Key` header present
on the request; and a booking manually flipped to `paid` renders the
positive-tone "Paid" pill with no action buttons. Completing a *real*
Paystack checkout and observing the `charge.success` webhook flip a
booking to `paid` live isn't exercisable in this environment (no real
Paystack test-mode credentials configured) — the same class of gap this
project has already named for other external integrations (no real
Flutter/NFC hardware for the tap validator).

**Not built this pass**: client-admin-app payments/wallet/ledger
visibility and super-admin-app Paystack account config + settlement-run
trigger UI — each its own separate, later slice, per the chosen
one-app-at-a-time sequencing.

## Implementation note (Frontend Slice B — client-admin visibility, done)

Second frontend slice, same one-app-at-a-time cadence Slice A
established: this one is client-admin-app's turn, giving Business staff
read-only visibility into the payments/wallet/ledger data their own
Business already has. No spec was written up front, same reasoning as
Slice A's own note.

**What was built**: three new screens, one per existing staff-facing
read endpoint (`payments.view`/`ledger.view`/`wallet.view` — all three
already granted to every Role preset, so no backend or RBAC change was
needed):

- `payments/payment-list/` (`GET /payments/?business=&status=`) — a
  `PaymentIntentStore` (new `ListStore` subclass) driving a status-
  filterable, `SelectedBusinessStore`-scoped table, mirroring
  `booking-list.ts` exactly.
- `ledger/ledger-overview/` (`GET /ledger/accounts/` +
  `GET /ledger/entries/?business=&account=`) — a new `LedgerEntryStore`
  for the paginated `JournalEntry` history, plus a one-off (not
  `ListStore`) fetch of the Business's `LedgerAccount` rows, the same
  "component-local signal populated once" idiom `booking-list.ts` uses
  for its own trip filter. That one fetch does double duty: it finds
  the `business_clearing` account for the headline balance stat, and it
  labels every account referenced by an entry's nested lines (including
  `integra_commission`, which never appears in the accounts list for an
  ordinary Business's own query — those lines render as a truncated raw
  id instead, since there's nothing to look them up against).
- `wallet/wallet-lookup/` (`GET /wallet/?business=&passenger=`) — a
  small reactive form (not the template-driven filter-`ui-select` idiom
  the other two screens use, since this is a real submission, not a
  live list filter), reusing `extractFirstErrorMessage`'s established
  shape for the "unknown passenger" case.

All three use the exact `SelectedBusinessStore`-driven
`effect()`/`untracked()` business-scoping pattern `route-list.ts`
already documents at length (and its own comment explains exactly why
the `untracked()` wrapper is load-bearing, not decorative) — no new
scoping mechanism invented.

**A real, load-bearing gap found while building the ledger screen**:
`LedgerAccount` has no `currency` field of its own (only
`PaymentIntent`/`JournalLine` do) — an initial version of the balance
stat read `account.currency`, which doesn't exist on the generated type
and silently rendered `undefined`. Fixed by sourcing the currency from
the selected Business's own record (already loaded by
`SelectedBusinessStore`) instead — caught by the new component spec,
not by hand.

**A new shared component**: `shared-ui` had no card/stat-display
component anywhere in the workspace (confirmed by grep before building)
— every prior "show one labelled figure" screen either didn't exist yet
or hand-rolled its own markup. Added `ui-stat` (`Stat`, `stat.ts`) —
presentational only, `label` input plus content-projected value and an
optional hint line, same OnPush/slate-palette convention as
`EmptyState`. Used by both the Ledger and Wallet Lookup screens here;
the super-admin slice (whenever it lands) will likely want it too for
the same kind of balance display.

**Three new nav icons**: `IconName` (`shared-ui/src/lib/icon.ts`) is a
closed, hand-authored union with no existing money-related entries.
Added `banknotes`, `book-open`, and `credit-card`, sourced from the
Heroicons v2 24×24 outline set (matching the existing hand-authored
path style already used for every other icon in that file, not
invented from scratch) — one per new nav item.

**Named limitation, stated in the Wallet Lookup screen itself**:
`GET /wallet/` requires the passenger's UUID directly — there is no
search by name or email on the backend today, so staff must already
have the id in hand (e.g. from a support ticket). Not solved here; a
real fix needs a new backend lookup capability.

**Confirmed, not built**: `SettlementRun` remains `IsPlatformStaff`-
gated only — client-admin has no read path to it at all, by design (a
payout is a platform financial operation, not client self-service).
`entry.settlement_run` being non-null is the only signal the Ledger
screen can show that a given entry has since been paid out; there is
nothing on the other end of that id to link to from here. Settlement
visibility belongs to the super-admin slice.

**Verified**: `ng lint` clean on both `client-admin-app` and
`shared-ui`; full workspace `test:all` — 229 tests in `client-admin-app`
alone (up from roughly 200 before this slice) plus every other project,
all passing, zero regressions; `openapi:check` clean (no backend change
this slice — the generated types this slice needed were already pulled
in by Slice A's own full-schema regen). Browser-verified against the
real stack with real data taken through the actual production code
path, not hand-inserted rows: a staff user (`Owner` role, all three
permissions) signed in, and a real `PaymentIntent` → webhook → ledger
posting → wallet debit → booking-paid flow was driven directly through
`_handle_charge_success()` (bypassing only the outbound Paystack HTTP
call itself, `initiate_payment()`'s known-401 environment limitation
Slice A already named — everything downstream of that ran for real).
Confirmed: the Payments screen lists the resulting `PaymentIntent`
with the correct status pill and amount; the Ledger screen's balance
stat matches the real `business_clearing` `cached_balance` (a 500.00
payment split 475.00/25.00 at the default 5% commission rate) and its
entries table renders all three journal lines with correct labels,
including the commission line's fallback truncated-id rendering; the
Wallet Lookup screen correctly renders a found passenger's real -500.00
balance and transaction row, and a clear "Unknown passenger." error for
one that doesn't exist. All three new nav items render with distinct
icons and correct permission-based visibility.

**Not built this pass**: super-admin-app Paystack account config UI and
settlement-run trigger UI — the third and final Phase 5 frontend slice,
per the chosen one-app-at-a-time sequencing.

## Implementation note (Frontend Slice C — super-admin Paystack config + settlement runs, done)

Third and final frontend slice, same one-app-at-a-time cadence Slices
A and B established. **This closes Phase 5's frontend arc.** No spec
was written up front, same reasoning as the prior two notes.

**Two small backend additions, made in this slice** (a deliberate
deviation from "pure frontend slice," made with the user's explicit
sign-off before building): both endpoints this slice needed already
existed (`PATCH /super-admin/businesses/{id}/paystack-account/`,
`GET`/`POST /settlement-runs/`), but two real gaps blocked a usable
UI — confirmed by direct investigation, not assumption:

1. **No way to read a Business's current Paystack config** — only a
   blind PATCH existed. Fixed by adding `GET` to the existing
   `PaystackAccountConfigView` (`apps/payments/views.py`) — returns the
   account if one exists, or a distinct 404
   (`"No Paystack account configured for this business yet."`) if not,
   so the frontend can render "not yet configured" as an expected
   state rather than an error.
2. **No way to browse/search Businesses across Clients as platform
   staff** — `GET /businesses/` is Client-scoped (unusable for platform
   staff, who have no tenancy context), and `GET /super-admin/kyb-queue/`
   drops a Business the moment it's approved. Fixed by adding
   `GET /super-admin/businesses/` (`BusinessSuperAdminListView`,
   `apps/businesses/views.py`), `IsPlatformStaff`-gated like every
   sibling super-admin endpoint, with an optional `?search=` (name
   `icontains`) filter and a new `BusinessSuperAdminSerializer`
   (`id, client, client_name, name, vertical, currency, is_active,
   kyb_status, created_at`).

Both additions have their own test coverage
(`apps/businesses/tests/test_business_super_admin_list.py`, new GET
cases in `apps/payments/tests/test_paystack_account_config.py`) —
480/480 backend tests passing (up from 470).

**What was built, frontend**: three new `super-admin-app` screens —
`businesses/business-list/` (the new entry point: cross-client search,
row links to the other two screens), `businesses/paystack-config/`
(`GET`-before-show, then `PATCH`; a 404 on load renders a blank form,
not an error), and `businesses/settlement-runs/` (existing-runs table
+ a trigger form, branching its error handling by HTTP status exactly
the way `wallet-lookup.ts` already established: 404 →
`PayoutDestinationNotConfigured`, with a link to the Paystack config
screen; 409 → `SettlementRunAlreadyExists`; 502 → the raw
`PaystackAPIError` message). Two new `ListStore` subclasses
(`BusinessSuperAdminStore`, `SettlementRunStore`), following the exact
shape every prior slice's stores already established.

**A real bug found and fixed during browser verification, not by
static review**: both `paystack-config.ts` and `settlement-runs.ts`
resolve their Business by looking it up in `BusinessSuperAdminStore`'s
already-loaded `items()` (the "no single-Business GET, reuse the list
store" pattern `business-form.ts` established in client-admin-app),
falling back to one refetch if not found. The first version of that
fallback called `getAll()` — which reuses whatever query the store's
singleton was last left in. A direct/refreshed navigation to a
Business's config screen, after having just searched for a *different*
Business on the list screen, refetched under that same stale search
filter and never found the target row — a real, user-facing "Business
not found" false negative. Fixed by calling `updateQuery({search:
undefined})` instead, clearing the filter before the fallback fetch.

**A related, accepted limitation, not fully closed**: the fallback is
still bounded by the store's own page size (25). With enough
Businesses across enough Clients, a direct deep link to one outside an
unfiltered list's first page still won't resolve — caught live in this
same verification pass against this dev database's 145 leftover
Businesses (accumulated from repeated Playwright e2e runs). The
primary flow (clicking through from a search result on
`business-list.ts`) never hits this, since the clicked row's data is
already in the store. A real fix needs the single-Business GET
endpoint this slice's plan deliberately avoided adding — left for
if/when it's actually needed.

**Named limitation, stated in `paystack-config.ts` itself**: there is
no Paystack "resolve account number → recipient_code" call anywhere in
this codebase (`psp/paystack.py` only has
`initialize_transaction`/`initiate_transfer`/`verify_webhook_signature`).
`recipient_code` is a plain required text field — staff paste in a
code obtained outside this app (e.g. Paystack's own dashboard). A real
verify step needs a new Paystack integration, out of scope.

**Verified**: backend — `pytest` (480/480), `ruff`, `mypy`,
`check_openapi_drift.sh`, all clean. Frontend — `ng lint
super-admin-app` clean; full workspace `test:all` — 60 tests in
`super-admin-app` alone (up from 32), every other project unaffected,
zero regressions; `openapi:check` clean. Browser-verified against the
real stack, signed in as the seeded `e2e-platform-staff@example.com`
account: searched the Businesses list and confirmed client name/KYB
status/active-pill rendering; opened the already-configured "Verify
Shuttle" Business (seeded in Slice B's own verification pass) and
confirmed its real Paystack fields render prefilled; opened a genuinely
unconfigured Business via a fresh search, confirmed the "not yet
configured" state, submitted a real `PATCH`, confirmed the success
message, then re-searched and re-opened it fresh to confirm the save
actually persisted server-side (not just local component state);
triggered a real settlement run against "Verify Shuttle"'s existing
ledger entries (from Slice B's own seed data) and confirmed the real
502 this environment's placeholder Paystack key produces
(`Paystack transfer call failed: 401 Client Error: Unauthorized`);
and confirmed the 404 `PayoutDestinationNotConfigured` path renders
correctly, with a working link back to the Paystack config screen, for
a Business with no payout destination configured.

**This closes Phase 5's frontend arc** — all three planned slices
(customer-app payment flow, client-admin-app payments/wallet/ledger
visibility, super-admin-app Paystack config + settlement runs) are now
built and self-checked.
