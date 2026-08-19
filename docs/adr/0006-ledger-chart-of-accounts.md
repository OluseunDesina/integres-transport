# ADR-0006: Ledger chart-of-accounts shape

Status: **Accepted** (2026-08-14). All three open questions below are
now resolved; this unblocks the Phase 5 spec per
`docs/status-report-2026-08-14.md` §7, alongside the payment partner
decision (ADR-0007).

## Context

The ledger is double-entry from day one: every value movement is balanced journal entries, and balances are derived from the ledger, never stored as an authoritative mutable field. This requires a chart-of-accounts taxonomy decided before `FareRule` (Phase 3) and `Wallet`/`PaymentIntent` (Phase 5) start referencing account types — retrofitting a chart of accounts after those exist means migrating historical journal entries.

## Decision

### Account taxonomy

Account types, scoped per-Business except where noted:

- **Wallet account** — per `(Passenger, Business)`, per ADR-000x wallet-scope decision (see the Phase 0 plan's contradiction #6: Wallet/Card/LedgerAccount scoped to `(Passenger, Business)`, not just Passenger).
- **Business clearing account** — per Business, accumulates fare revenue pending settlement.
- **Integra commission account** — platform-level, accumulates commission split off each transaction.
- **PSP suspense account** — per Business per provider, tracks funds acknowledged by the PSP but not yet reconciled/settled.
- **Refund/chargeback contra accounts** — per Business, so refunds and chargebacks are visible as their own ledger movements rather than reversed in place (preserves the "keep our own record of every payment regardless of what the PSP reports" requirement).

Every `JournalEntry` is a set of balanced `JournalLine`s (debits == credits, enforced by an invariant test, not just application logic). Wallet/account "balance" is always `SUM(JournalLine.amount)` for that account, optionally cached per the Phase 0 plan's resolution of contradiction #1 (cache written transactionally alongside the journal write, reconciled periodically against the derived sum).

### Commission split: one balanced entry, not two linked ones

A successful payment writes **one** `JournalEntry` with three
`JournalLine`s — passenger debit, Business clearing-account credit,
Integra commission-account credit — rather than a separate commission
entry referencing the original. Reasoning: the ledger's core invariant
is "every entry's debits equal its credits, enforced by a test, not
just application logic" (see Context above); a single three-line entry
satisfies that invariant atomically in one write, while two linked
entries would need the *pair* to balance across two rows, which is a
strictly weaker guarantee (a bug or partial failure could write one
entry without the other) for no offsetting benefit — reconciliation
queries against a single entry with three lines are simpler, not
harder, than joining two entries by a reference field.

### Settlement runs: a per-Business batch that journal entries point at, not the reverse

Payouts are modeled as a `SettlementRun` row per `(Business, period)`.
Each `JournalEntry` touching that Business's clearing account carries a
nullable `settlement_run` foreign key, set exactly once, at the moment
that entry is included in a payout batch. This direction (entries point
at their batch, not a batch listing its entries as a collection field)
makes "what's the Business's current unsettled clearing balance" a
single indexed query (`WHERE business = ? AND settlement_run IS NULL`)
and makes settlement itself naturally idempotent — an entry already
assigned to a `SettlementRun` cannot be silently picked up by a second
one, because the assignment is a normal unique write, not a
set-membership check that could race.

### Refunds and concessions share the existing contra accounts

Concession/discount adjustments reuse the refund/chargeback contra
accounts already proposed above rather than getting a distinct account
type. A concession is economically the same movement as a partial
refund — value returning from the Business clearing side back toward
the passenger — and the taxonomy is meant to reflect economically
distinct movements, not distinct UI reasons for making one; a separate
account type here would be a distinction without a ledger-relevant
difference, and would multiply the reconciliation surface for no
analytical gain.

## Consequences

`apps/ledger`'s `LedgerAccount` model gains a fixed, enumerated
`account_type` field matching this taxonomy from its first migration,
avoiding an early destructive migration to add account types after real
financial data exists. `JournalEntry` gains a nullable `settlement_run`
FK from its first migration for the same reason. Phase 5's spec builds
`apps/payments` and `apps/ledger` directly against this taxonomy;
neither the commission-split shape nor the settlement-run FK direction
is open for reconsideration during that spec — per this repo's own
working agreement, a proposed ADR is finalized *before* the phase that
needs it is spec'd, not during it.
