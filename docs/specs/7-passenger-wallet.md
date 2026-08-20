# 7-passenger-wallet: Passenger Wallet

Deferred from live-testing triage (2026-08-19), spec'd per this repo's
"spec before code" rule before any implementation starts. Also closes
a gap the same session's UI sweep found: `GET /wallet/mine/` has
existed since Phase 5 Slice 2 with zero frontend consumers — a
passenger has never had any screen showing their own wallet, even
read-only. That gap is folded into this spec rather than fixed
separately, since a read-only balance view is a strict subset of what
this spec builds anyway.

## Context: the wallet ledger account already exists, just never funded

`apps.wallet`/`apps.ledger` (Phase 5) already model a wallet as
`LedgerAccount(account_type="wallet", business, passenger)` — see
`docs/specs/5-payments-wallet-ledger.md`'s account taxonomy and
`docs/adr/0006`. What doesn't exist yet is any way to put money into
one. Today, `apps.payments.services._handle_charge_success()` (the
Paystack webhook handler) posts every successful booking payment as a
3-line entry — wallet debit, business-clearing credit, commission
credit — **regardless of whether the passenger ever had a wallet
balance**. A passenger who has never topped up still gets their wallet
account debited by every booking they pay for with a fresh card
charge, so `cached_balance` trends negative from a first payment
onward. This was harmless while nothing displayed the balance and
nothing could ever credit it back — it's the reason this spec changes
that write path (see Data model changes) rather than leaving it as
found.

## Scope and non-goals

**In scope**:
- Standalone wallet top-up: a Paystack charge with no `Booking`
  attached, crediting the passenger's `(business, passenger)` wallet
  account.
- Paying a booking entirely from wallet balance, as an alternative to
  a fresh Paystack checkout — not a blend of the two (see non-goals).
- A `customer-app` wallet screen: balance, transaction history,
  top-up action. Closes the read-only-view gap named above.
- A "Pay from wallet" action alongside `my-bookings`' existing "Pay
  now" (Paystack) action, shown only when the wallet balance covers
  the booking's `total_amount`.
- Fixing the wallet-debit-on-every-card-payment behavior described
  above, so `cached_balance` is a real, always-accurate prepaid
  balance once this spec ships (see Data model changes) — a
  correctness fix this spec's own top-up feature requires to be
  meaningful, not a separate, optional cleanup.

**Non-goals** (deliberate, named so they don't read as missed):
- **Split/partial payment** (part wallet, part fresh card charge for
  the remainder). The original request ("the option to either pay
  with their wallet or using any other channel") reads as an
  either/or choice, not a blend — and a blend needs its own partial-
  refund/reconciliation design if either leg fails mid-flight. A
  booking is paid either 100% from wallet or 100% via Paystack.
- **Choosing a specific Paystack channel** (card vs. bank vs. USSD vs.
  mobile money). Already free — Paystack's own hosted checkout page
  (the existing `authorization_url` redirect) already offers every
  channel Paystack supports with no backend involvement. Nothing to
  build here.
- **`apps.tapngo` wallet-debit** (paying a closed `FareJourney` from
  wallet balance after the fact, with no interactive checkout moment).
  Already named as a Phase 5 non-goal for the same reason — "two
  concurrent spends against the same balance" is a distinct
  concurrency problem from this spec's own "pay one specific booking,
  once" shape. Still out of scope here.
- **Refunds crediting the wallet.** `refund_contra` already exists in
  the taxonomy for refunds; routing a refund back into the wallet
  specifically (vs. a bank refund) is a real product decision this
  spec doesn't make.
- **Multi-currency wallets.** A wallet is already scoped to one
  `(business, passenger)` pair — one Business, one currency
  (`business.currency`), matching `LedgerAccount`'s existing shape.
  Unchanged.
- **A minimum/maximum top-up amount, or a wallet balance cap.** Left
  unenforced in this spec — flagged as an open question below rather
  than guessed at.

## Data model changes

### `apps/payments` — `PaymentIntent` gains an intent type

| Field | Change |
|---|---|
| `intent_type` | New `CharField`, choices `booking_payment` (default, for every existing row via a data migration) / `wallet_topup`. |
| `booking` | Changes from non-nullable to **nullable**. Required iff `intent_type == booking_payment`. |
| `wallet_business` | New `ForeignKey → businesses.Business, PROTECT, related_name="+"`, nullable. Required iff `intent_type == wallet_topup` — a top-up has no `Booking` to denormalize a Business from, so the caller states which Business's wallet is being funded directly (matches `LedgerAccount.wallet`'s own `(business, passenger)` scoping). |

```python
constraints = [
    models.CheckConstraint(
        condition=(
            Q(intent_type="booking_payment", booking__isnull=False, wallet_business__isnull=True)
            | Q(intent_type="wallet_topup", booking__isnull=True, wallet_business__isnull=False)
        ),
        name="payment_intent_booking_xor_wallet_business",
    ),
]
```

Same "field required iff enum value" idiom `LedgerAccount`'s own
`ledger_account_passenger_iff_wallet` constraint already established —
not a new pattern.

**`business`/`passenger`/`amount`/`currency` stay as-is** — for a
top-up, `business` is set from `wallet_business` and `amount`/
`currency` come from the passenger's requested top-up amount and
`business.currency`, same denormalization role they already play for
booking payments.

### `apps/ledger` — `JournalEntry.EntryType` gains `TOPUP`

Additive `TextChoices` member. A top-up entry has two lines: wallet
credit `+amount`, `psp_suspense` (same Business) debit `-amount` —
the first real write to `psp_suspense` since Phase 5 defined it
unused ("nothing writes to it this phase" — Phase 5 spec's own
non-goals). This is `psp_suspense`'s documented purpose exactly:
"funds acknowledged by the PSP, not yet reconciled/settled."

### `apps/payments/services.py` — `_handle_charge_success` changes

**Changed behavior, not additive**: the existing booking-payment path
currently debits the passenger's wallet account for the full amount
on *every* successful charge, including a plain fresh-card payment
that never touched a wallet balance at all. This is corrected so the
wallet account only ever reflects genuine top-up credits and genuine
wallet-sourced spend:

- **`intent_type == booking_payment`, paid via a fresh Paystack
  charge** (unchanged trigger — the existing `POST /payments/` flow):
  the 3-line entry's first line changes from a **wallet** debit to a
  **`psp_suspense`** debit. Money the PSP has acknowledged flows out
  to clearing + commission; the passenger's wallet balance is
  untouched, since they never drew on it.
- **`intent_type == wallet_topup`**: new 2-line entry, wallet credit
  `+amount` / `psp_suspense` debit `-amount`, per above.
- **Booking paid directly from wallet** (new `pay_booking_from_wallet()`
  service function, no Paystack round-trip): the 3-line entry keeps
  today's exact shape (wallet debit, clearing credit, commission
  credit) — this is the one case where debiting the wallet account is
  actually correct, since real balance is actually being spent.

No migration touches historical `JournalLine` rows — this only
changes which account future writes target. Existing entries keep
their historical (technically-mislabeled) wallet debits; not
backfilled, since backfilling financial history is its own, separate,
higher-stakes decision this spec doesn't make.

## API surface

**Passenger-facing** (`IsAuthenticated`, matches every existing
`apps.payments`/`apps.wallet` passenger endpoint):

- `POST /payments/` — **body gains an optional discriminated shape**:
  `{"booking_id": "..."}` (existing, unchanged, `intent_type` inferred
  as `booking_payment`) or `{"wallet_topup": {"business_id": "...",
  "amount": "500.00"}}`. Same `Idempotency-Key` requirement as today.
  Returns the same `{id, status, authorization_url, reference}` shape
  either way — the frontend's redirect-to-Paystack logic is identical
  for both request shapes, no new client-side branching needed beyond
  which body to send.
- `POST /bookings/{id}/pay-from-wallet/` — new. `404
  PspNotConfigured`-style pattern isn't relevant here (no PSP
  involved); instead `409 InsufficientWalletBalance` if the wallet's
  current balance is less than `booking.total_amount`. On success,
  returns the same booking-paid outcome `charge.success` already
  produces (booking `PAID`, seats `CONFIRMED`) — synchronously, no
  webhook round-trip, since no external PSP call happens.
- `GET /wallet/mine/?business=` — **unchanged endpoint**, now returns
  a balance that's actually meaningful once the write-path fix above
  ships.

No change to the existing `GET /payments/`, `GET /wallet/?business=&passenger=`
staff endpoints beyond `PaymentIntent`'s new `intent_type` field
appearing in their existing serializer output.

## Edge cases

1. **Insufficient wallet balance at `pay-from-wallet` time.** `409
   InsufficientWalletBalance` — checked inside the same
   `transaction.atomic()` block as the debit, under
   `select_for_update()` on the wallet `LedgerAccount` row, so a
   balance read and the debit that follows it can't race against a
   concurrent spend of the same balance (mandatory concurrency test,
   § Test plan).
2. **Two concurrent attempts to pay the same booking** — one via
   `pay-from-wallet`, one via a fresh `POST /payments/` Paystack
   charge, fired near-simultaneously. Both paths must still respect
   `PaymentIntent`'s existing `one_pending_payment_intent_per_booking`
   partial-unique constraint and `Booking`'s own status check inside a
   locked transaction (mirrors `mark_booking_paid`'s existing
   re-check-after-lock discipline) — whichever commits first wins, the
   second sees the booking already `paid` and fails cleanly with the
   existing `BookingNotPayable`-style error, not a double charge.
3. **Top-up amount is zero or negative.** Rejected by input validation
   before any Paystack call, same shape as `PaymentIntent.amount`'s
   existing `DecimalField` validation elsewhere.
4. **A top-up's Paystack charge succeeds, but the passenger never
   actually spends it.** Not an edge case this spec needs to handle —
   the balance just sits credited, same as any real prepaid balance.
5. **`wallet_business` refers to a Business the passenger has never
   interacted with before** (no prior bookings). Allowed — top-up is
   the thing that first creates the wallet `LedgerAccount` row for
   that `(business, passenger)` pair, via the existing
   `get_or_create_wallet_account()`.

## Failure modes

- **Torn writes**: unchanged discipline — every new write
  (`pay_booking_from_wallet`, the topup branch of
  `_handle_charge_success`) happens inside one `transaction.atomic()`
  block, no intermediate state ever visible, matching every other
  money-moving function in `apps.payments`/`apps.ledger`.
- **PSP downtime during top-up initiation**: identical to the existing
  booking-payment behavior — no `PaymentIntent` row is created if the
  Paystack `initialize` call itself fails, so a retry under the same
  `Idempotency-Key` is clean.
- **Concurrency on wallet balance**: every spend/credit against a
  wallet account happens under `select_for_update()` on that account's
  row — see Edge case 1/2.

## Test plan

**Backend**:
- `_handle_charge_success`'s changed write path: a fresh booking-card
  payment now debits `psp_suspense`, not `wallet` — assert the
  specific accounts touched, not just that the entry balances.
- Top-up write path: wallet credited, `psp_suspense` debited, `SUM
  == 0`.
- `pay_booking_from_wallet()`: sufficient-balance success path,
  insufficient-balance `409`, booking transitions to `PAID` with seats
  `CONFIRMED` identical to the Paystack path.
- **Concurrency (mandatory)**: N concurrent `pay_booking_from_wallet()`
  calls against a wallet balance that can cover exactly one of them —
  exactly one succeeds, the rest see `InsufficientWalletBalance`, no
  balance ever goes negative. Same standard as every other mandatory
  spike in this codebase (`test_seat_concurrency.py`,
  `test_tapngo_concurrency.py`, `test_settlement_run_concurrency.py`).
- **Concurrency (mandatory)**: a wallet-pay and a fresh Paystack
  webhook success racing for the same booking — exactly one
  `PaymentIntent` reaches `succeeded`, the booking transitions exactly
  once.
- Idempotency: top-up `POST /payments/` replay semantics, identical
  shape to the existing booking-payment idempotency tests.
- Migration test: existing `PaymentIntent` rows backfill
  `intent_type="booking_payment"` correctly, `booking` stays
  non-null for all of them.

**Frontend** (`customer-app`):
- New `wallet` screen: balance + transaction list render, top-up form
  submits and redirects to Paystack.
- `my-bookings`: "Pay from wallet" renders only when balance covers
  the total; hides/disables otherwise; falls back cleanly to the
  existing "Pay now" Paystack action.

**E2E**: extend the existing booking/payment Playwright coverage with
one wallet-funded booking-payment path, alongside the existing
Paystack-redirect path.

## Migration impact

**Non-destructive but not purely additive**: `PaymentIntent.booking`
changes from non-nullable to nullable (a widening, safe change), plus
the new `intent_type`/`wallet_business` columns and the new
constraint. A data migration backfills `intent_type="booking_payment"`
for every existing row before the new `CheckConstraint` is added, so
existing data satisfies it from the moment it's enforced. No row is
deleted or has its `booking`/`amount`/`currency` altered. Requires
sign-off before running against any environment with real payment
history (same "explicit approval before a destructive-adjacent
migration" bar `docs/specs/4-fares-seating-booking-versioning.md`
already set), even though no data is lost — because it changes the
enforced shape of an already-populated table, not because anything is
deleted.

## Open questions

- Minimum/maximum top-up amount, and any cap on total wallet balance —
  not resolved here, deliberately (§ Non-goals). `ASSUMPTION:` none
  enforced at launch; Paystack's own minimum charge amount is the only
  practical floor.
- Whether a passenger should be able to see a *per-Business* wallet
  list (they may have wallets with several operators) versus always
  passing an explicit `?business=`. `ASSUMPTION:` the wallet screen is
  reached from a Business-scoped context (e.g. from a specific
  operator's trip search), same as `GET /wallet/mine/?business=`
  already requires — no cross-Business wallet directory screen this
  pass.

## Implementation note (Slice A — backend, done)

Built as spec'd: `PaymentIntent.intent_type`/`wallet_business` (one
migration, `apps/payments/migrations/0003_...` — additive, `booking`
widened to nullable, backfilled automatically by Django's own
`AddField(default=...)` mechanism, no hand-written data migration
needed), `JournalEntry.EntryType.TOPUP` (code-only, no schema change —
same "additive choices, no DB enforcement" shape `Booking.Status.PAID`
already established in Phase 5), `initiate_wallet_topup()`,
`pay_booking_from_wallet()`, the discriminated `POST /payments/` body
(`booking_id` xor `wallet_topup`), and `POST
/bookings/{id}/pay-from-wallet/`. The write-path change to
`_handle_charge_success` (split into `_apply_booking_payment`/
`_apply_wallet_topup`, the former now debiting `psp_suspense` instead
of the passenger's wallet) shipped exactly as this spec's own
"Context" section described. 18 new tests, 532/532 backend-wide
passing (up from 514); `ruff`/`mypy` clean; `makemigrations --check`
clean; OpenAPI regenerated and drift-checked clean (needed
`request=None` on the new `PayBookingFromWalletView`'s `@extend_schema`
— a plain `APIView` with no request body confuses drf-spectacular's
serializer-guessing into a hard error otherwise); `grep -rn
"\.all_objects\."` confirms every new use is confined to
`apps/payments/services.py`. Both mandatory concurrency spikes
(`apps/payments/tests/test_wallet_payment_concurrency.py`) passed
reliably across five repeated standalone runs: N concurrent
`pay_booking_from_wallet()` calls against a balance covering exactly
one (exactly one succeeds, balance never goes negative, every loser
fails with `InsufficientWalletBalance` specifically), and a wallet-pay
racing a Paystack webhook `charge.success` for the same booking (the
booking is paid exactly once, whichever side loses recognizes it
correctly rather than double-transitioning).

**One real bug found and fixed — by the second concurrency spike,
not by static review**: `apps.booking.services.mark_booking_paid()`
originally returned just the `Booking`, and every caller decided
whether to flag `PaymentIntent.requires_manual_refund` by checking
`booking.status != PAID`. That check could not distinguish "this
payment is what paid the booking" from "a *different* PaymentIntent
already paid it first" — both looked identical (`status == PAID`
either way). Before Phase 7, this was unreachable in practice (the
only two ways to reach `PAID` were a single card `PaymentIntent`'s own
webhook, gated by that intent's own `pending`-only partial-unique
constraint), but `pay_booking_from_wallet()` is a second, independent
path to `PAID` that bypasses that constraint entirely (it never goes
through a `pending` state at all) — so a wallet-pay and a card payment
racing for the same booking could both "succeed" from the ledger's
perspective: the loser's money still moved into `psp_suspense`/wallet,
but its own `requires_manual_refund` never got set, silently losing
track of a real double-payment. Fixed by changing
`mark_booking_paid()`'s return type to `tuple[Booking, bool]` —
`did_transition` is `True` only for whichever call actually performed
the `PENDING_PAYMENT`→`PAID` transition — and updating both callers
(`_apply_booking_payment` now checks `did_transition` instead of
`booking.status`, correctly covering the pre-existing expired/cancelled
case *and* the new already-paid-by-another-intent case identically;
`pay_booking_from_wallet` asserts it's always `True`, since it holds
the booking's row lock continuously from before its own
`PENDING_PAYMENT` check through the call, making the false case
provably unreachable there).

**Not built this pass, as agreed before implementation started**:
Slice B (customer-app wallet screen, top-up UI, "Pay from wallet"
action on `my-bookings`) — spec'd above, deferred to its own reviewed
slice. Seat-map generation and notifications (the other two deferred
enhancements) — untouched.

## Implementation note (Slice B — customer-app frontend, done)

Built as spec'd, no backend change: a new `wallet` screen
(`customer-app/src/app/wallet/wallet.ts`) and a "Pay from wallet"
action on `my-bookings`. customer-app has no persistent "active
Business" concept the way `client-admin-app`'s `SelectedBusinessStore`
does, so the wallet screen's own Business picker is sourced from `GET
/routes/browse/`, deduped by `business.id` — the same source
`trip-search.ts` already draws its own Business-disambiguation labels
from, not a new endpoint. `my-bookings.ts` fetches one wallet balance
per distinct Business among the passenger's `pending_payment` rows
(usually just one request) and only renders "Pay from wallet" when
that balance covers the row's `total_amount` — a plain `Number()`
comparison, deliberately not exact-Decimal, since it only gates
whether a button renders; the backend's own `pay_booking_from_wallet()`
independently re-checks the real balance under a row lock at payment
time regardless of what the button decided to show. 10 new customer-app
tests, 117/117 passing (up from 107); `ng lint`/`ng build` clean.

**Verified live against the real backend and a real booking**, not
just unit tests: seeded a real `pending_payment` booking (₦750) via
the actual `POST /bookings/` flow, funded the wallet directly with
₦1000 (Paystack isn't reachable from this dev sandbox — the same
documented limitation earlier phases' verification passes already
hit), then drove the browser through both flows. The wallet screen
correctly showed the real ₦1000.00 balance and correctly surfaced
Paystack's real `401` on a top-up attempt (proving the request reaches
the backend with the right payload, not that top-up "works" in this
sandbox — same caveat as every other real-Paystack-call verification
this project has done). "Pay from wallet" on `my-bookings` correctly
transitioned the row from "Pending payment" (three actions: Pay now /
Pay from wallet / Cancel) straight to "Paid" (View tickets only) in
one click — confirmed via a follow-up `GET /wallet/mine/` that the
balance actually moved ₦1000.00 → ₦250.00, a real `-750.00` ledger
line matching the booking's exact total.

**This closes Phase 7 (Passenger Wallet) entirely** — both slices
built, tested, and verified.
