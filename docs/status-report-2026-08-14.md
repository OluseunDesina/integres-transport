# Integra AFC — Engineering Status — 2026-08-14

**Audience**: project stakeholders with a technical background — enough
to read a phase plan and an architectural decision, not necessarily
enough to read the code.

**Purpose**: state what is built, what is being built, what is
deliberately not being built yet, and what decision is currently
blocking the project. Companion to `docs/architecture.md`. Supersedes
`docs/status-report-2026-08-10.md`.

---

## 1. Where we are

Phases 0 through 4 are now complete and self-checked, including Phase
4's frontend — the platform can model an operator's entire physical
network, sell a reserved seat on it through a real passenger UI, and an
operator can see what's been booked. **As of Phase 5 Slice 2, it can
now take money**: a passenger can pay for a booking through Paystack
end to end.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation, tenancy, CI, auth skeleton | Complete, self-checked |
| 1 | Identity, Client, Business, RBAC | Complete, self-checked |
| 2 | Client-admin + super-admin consoles | Complete, self-checked |
| 3 | Network, Scheduling, Fleet | Complete, self-checked |
| 4 | Fares, Seating, Booking (backend + frontend) | Complete, self-checked (§2) |
| 4v | Fare versioning + price snapshotting | Complete, self-checked — unplanned, see §3 |
| 4b | Tap-and-go fare determination | **Backend + operator harness built** (§4); customer-app credential UI not yet built |
| 5 | Payments, Wallet, Ledger | **Spec'd in full; Slices 1–2 built** (§6) — ledger foundation and real Paystack payment/webhook handling both work end to end. Slice 3 (settlement runs) spec'd, not yet built |
| 6 | QR ticketing + validator | Unblocked technically; sequenced after Phase 5 |

## 2. Shipped since the last report

**The passenger booking flow, end to end.** A passenger can sign in,
search trips by route and date, pick a seat off a live availability map,
review a priced summary, and reserve it — landing in `pending_payment`,
same terminus the backend always had. They can see their own booking
history and cancel a pending one. An operator's staff can see every
booking against their business, filterable by trip and status, read-only
(they cannot act on a passenger's booking).

**How it shipped is itself worth reporting.** This work — and a second,
separate feature described below — was built by an external coding tool
in one continuous pass, without pausing between the planned review
checkpoints. Nothing was broken by that, but nothing had been reviewed
either, until this report's own verification pass caught up to it after
the fact: a real backend bug (a management command that stopped being
safely re-runnable), a real shared-component UI bug (a dropdown that
could overflow its container), and several test-quality issues were
found and fixed only during that catch-up. The process gap is now on the
record and the working agreement's checkpoints are expected to hold
going forward.

**A second, unplanned feature: fare history.** Editing a fare's price
used to be able to retroactively change what an already-placed booking
would show as owed — nothing had captured what a passenger was actually
quoted at the moment they booked. That gap is now closed: fares carry an
effective-dated history instead of being edited in place, and every
booking snapshots the exact price, currency, and originating fare rule
it used, permanently, regardless of what happens to the fare afterward.
This is a real, legitimate fix for a real, money-adjacent correctness
gap — the concern is entirely that it shipped the same way as the
booking UI above: unreviewed, undiscussed, with irreversible database
changes already applied before anyone outside this catch-up pass had
seen it.

Backend test suite: **346 tests passing, 98% coverage**, type-checked
and lint-clean — up from 303 at the last report, all of the growth from
the two items above.

## 3. What this report is flagging, plainly

Two features reached "done" without going through this project's own
review process. The code in both cases is solid — thoroughly tested,
matches its (in one case retroactively written) spec, and a full
verification pass this week found nothing that doesn't work. That is
not the same as saying the process is fine. It isn't, twice over: once
for shipping a spec'd feature without its planned review checkpoints,
and again for shipping an entirely unplanned one alongside it with no
spec at all until this catch-up wrote one. Full detail, including every
individual finding, is in `docs/self-check-2026-08-14-phase4-frontend.md`
and the retroactive spec at `docs/specs/4-fares-seating-booking-versioning.md`.

**What's being done about it**: nothing silently. Both are now spec'd
(one retroactively), self-checked to the same bar every other phase has
been held to, and reported here rather than folded in as if they'd
always been reviewed work.

## 4. Tap-and-go: backend and operator harness both built

Spec'd and built 2026-08-14 (`docs/specs/4b-tap-and-go.md`) — backend
only at first; the operator harness followed two days later
(2026-08-16, on direct request) as `validator-app`, a fourth
installable-PWA Angular app, not the unstyled page the spec originally
scoped — see that spec's two "Implementation note" sections for the
full account of both. The customer-app credential-issuance UI and a
permanent Playwright E2E spec for the harness are still not built.
Until the backend work landed, the mode was selectable on a business and carried on
every trip, but the only code path behind it was a rejection: the
booking API refuses any trip not in reservation mode. That's still true
for the reservation flow — tap-and-go is now a real, separate flow
alongside it, not a replacement.

**Scope: fare determination, not fare collection.** The new
`apps.tapngo` app (`TapCredential`, `FareJourney`, `TapEvent`) records
board and alight taps against a trip, resolves the travelled segment
the same way `apps.seating` already does (`RouteStop.sequence`), and
prices it through the existing `apps.fares.services.get_fare()`
unchanged. It stops there — settlement belongs to Phase 5. The
one-open-journey-per-passenger invariant is enforced by a Postgres
partial unique index (simpler than seating's GiST exclusion constraint,
since this isn't a range-overlap problem) and proven under real
concurrency the same way ADR-0004's own spike was — 6 concurrent board
taps for the same passenger, exactly one succeeds, confirmed across 3
consecutive fresh-database runs. 37 new tests (383/383 backend-wide, up
from 346); `ruff`/`mypy`/migration-completeness/OpenAPI-drift all
clean.

**The validator problem, and how the spec routes around it.** A
lightweight, explicitly unstyled web harness standing in for the
Flutter validator app's button presses, driving the real API — named in
the spec as exempt from the usual design/accessibility bar, since it's
internal QA plumbing standing in for hardware that doesn't exist yet.

**The open question this slice needed to answer, now settled:** what a
passenger presents at the validator. Confirmed with the product owner —
**either a QR code or an NFC device** (phone, physical card, or watch),
both resolving through the same opaque, revocable `TapCredential` token
so the backend never needs to know which transport was used. The spec's
own "Tap identifier" section covers why this doesn't wait on ADR-0005's
still-Proposed QR ticket signing scheme (different problem, much lower
stakes — see the spec for the full reasoning).

## 5. Architectural decisions

**Update, same day as the correction below was written**: ADR-0006
(ledger chart-of-accounts) is now **Accepted**. Its three open
questions are resolved directly in the ADR: commission split is one
balanced three-line journal entry (not two linked entries), settlement
runs are a `SettlementRun` per `(Business, period)` that journal entries
point at via a nullable FK (not the reverse), and concessions/refunds
reuse the existing contra accounts rather than getting a new account
type. A new ADR-0007 settles the other Phase 5 blocker: **Paystack** is
the payment partner, confirmed with the product owner. Paystack does
not currently operate in Botswana — surfaced explicitly before the
decision was confirmed, not after — so the Botswana metro operator's
path to live payments is a named, tracked gap (a second PSP, most
likely DPO Group given its Southern Africa coverage) rather than a
silent assumption. **Both of Phase 5's blockers are resolved as of
today**; Phase 5 itself is now spec'd in full, with its first backend
slice built (§6).

**Correction (retained from the original version of this report)**: the
report prior to this one (2026-08-10) stated ADR-0005 (QR ticket
signing) and ADR-0006 were "signed off." Checked directly against the
ADR documents themselves while preparing this report: both were still
marked **Proposed**, not Accepted, at the time — `CLAUDE.md` had stated
the same "still need finalizing" position throughout. ADR-0006 has since
been finalized today, per the update above; ADR-0005 remains
**Proposed**, gating Phase 6 only.

ADR-0004 (seat-segment concurrency), by contrast, has been **Accepted**
since Phase 4 — proven by the concurrency spike test in
`apps/seating/tests/test_seat_concurrency.py`, which passes reliably.

## 6. Phase 5: ledger foundation and real Paystack payments both shipped

Spec'd in full 2026-08-16 (`docs/specs/5-payments-wallet-ledger.md`) —
all three backend slices' data model, API surface, edge cases, and test
plan decided up front, matching this repo's "spec before code" rule.
Slices 1 and 2 are both now built, each stopped for review before the
next started, the same discipline Phase 4's three backend slices used —
and the one this report's own §2–§3 named as having slipped once
already. It held both times.

**Slice 1 — the ledger foundation**: `apps/ledger` — `LedgerAccount`
(`account_type` taxonomy fixed per ADR-0006: `wallet`,
`business_clearing`, `integra_commission`, `psp_suspense`,
`refund_contra`), `SettlementRun` (data model only, no payout logic
yet), `JournalEntry`/`JournalLine` (signed line amounts, so
`SUM(amount) == 0` per entry is literally the balance invariant
ADR-0006 calls for). `apps.ledger.services.post_journal_entry()` is the
sole write path, enforced in application code and independently
re-verified by a database-wide sweep test — not by a database trigger.
Two staff-facing read endpoints, gated on a new `ledger.view`
permission.

One real bug found and fixed here, by running the staff endpoint tests
against real data, not by static review: a query optimization
(`select_related` against the ledger-account table) silently dropped
any journal line referencing the platform-level commission account
when read by an ordinary operator's staff — a genuine interaction
between Postgres row-level security and SQL joins, not a logic error in
the ledger math itself. Fixed by reading the referenced account's ID
directly instead of joining to it.

**Slice 2 — actual Paystack payments**: `apps/payments` (this
backend's first outbound third-party HTTP integration — a new
`requests` dependency, confined to `apps/payments/psp/paystack.py`) and
`apps/wallet` (a thin read layer, no model of its own). A passenger can
now `POST /payments/` for a `pending_payment` booking, be redirected to
a real Paystack checkout, and have a `charge.success` webhook
atomically post the three-line ledger entry, mark the `Booking` `paid`,
and confirm its held seats — the actual terminus `Booking.status ==
pending_payment` has waited on since Phase 4. Fails closed with a clear
404 (not a generic 500) for any Business with no Paystack account
configured — the literal mechanism by which the Botswana coverage gap
(ADR-0007) surfaces to a real passenger, with zero country-sniffing
logic anywhere. The commission rate itself
(`INTEGRA_COMMISSION_RATE_PERCENT`) is a required environment variable
with no code default, resolved with the product owner as a real
decision rather than a placeholder guess.

**Two real, non-obvious bugs found and fixed in Slice 2, only by
running the webhook flow under real concurrency**: (1) Django's
`Model.save(update_fields=...)` always performs its UPDATE through the
tenant-filtering manager regardless of which manager fetched the
instance, so a save made with no active tenant context (exactly the
webhook's situation) silently targeted zero rows — this was already
latent in Slice 1's own ledger-write code, just never triggered by
Slice 1's own tests. Fixed at the root (`BaseModel.Meta.base_manager_name`),
which required one schema-inert migration per app with a tenant-owned
model — twelve apps, none touching the database schema. (2) this
codebase's RLS-bypass helper for system code with no tenancy context
turned out not to be safe to call from within itself — the webhook
handler's own nested use of it (calling into the ledger-write code,
which calls it again) silently broke row visibility partway through
processing. Fixed by making it properly re-entrant. Full account of
both in the spec's own "Implementation note (Slice 2, done)" section.

96 new tests across both slices; 449/449 backend tests passing (up from
383); `ruff`/`mypy`/`makemigrations --check`/OpenAPI-drift all clean;
all three mandatory concurrency spikes passed reliably (concurrent
wallet-account creation, concurrent payment initiation for one booking,
and the flagship spike — N concurrent identical webhook deliveries for
one payment, exactly one ledger entry and one booking transition).

## 7. Still deferred

**Settlement runs (payouts to operators), transaction history,
reporting dashboards.** Design is settled (`SettlementRun`'s shape
already exists as of Slice 1); execution logic is Slice 3, not yet
built. Until it lands, a Business's clearing-account balance
accumulates but is never paid out.

**A second PSP for Botswana.** Named and tracked since ADR-0007; not
needed until that operator is actually brought onto payments.

**QR ticketing and the Flutter validator app.** Design is settled;
sequenced after payments.

## 8. What we need from stakeholders

**Resolved today: the payment partner (Paystack, ADR-0007) and the
ledger chart-of-accounts (ADR-0006).** Both were the only blockers on
Phase 5's spec being written; neither remains open. What's now
genuinely still open, for a later decision, not an immediate blocker:

- **A second PSP for the Botswana metro operator**, since Paystack
  doesn't cover that market. Not needed until that operator is actually
  brought onto payments — DPO Group is the leading candidate per
  ADR-0007's "options considered."

## 9. Known gaps, for completeness

- Two features (§2, §3) shipped without the planned review checkpoints;
  now caught up and self-checked, but it's worth stakeholders knowing
  this happened, not just that it's now resolved.
- The repository still has zero git commits — everything described in
  this report, across every phase, exists only in a local working tree.
  This is a growing risk, not a static one: the amount of unreviewed-
  until-caught-up-with work now sitting uncommitted is larger than at
  any prior report.
- A CI workflow exists but has still never actually run.
- The e2e test suite is only reliably green at reduced parallelism in
  the current local sandbox; full-concurrency runs show transient,
  environment-caused failures unrelated to code correctness.
- KYC/KYB uploads write to local disk; production object storage is
  documented but not built.
- Production reverse-proxy topology for white-labelled custom domains is
  specified but not provisioned.
- Platform-staff permissions are a coarse all-access flag;
  per-permission granularity exists only on the client side.
- A pre-existing, previously-documented gap (accumulated test data
  outrunning an unpaginated `limit=100` picker) is confirmed still
  present and now affects a second picker (bookings' trip filter, not
  just the business switcher) — not fixed, per the same reasoning as
  when it was first found.
- The Botswana metro operator still cannot go live on Phase 5 payments,
  now that they're actually built — Paystack, the chosen partner,
  doesn't operate there (§5, §8). Named and tracked, not silently
  deferred.
- Phase 4b (tap-and-go) backend and operator harness (`validator-app`)
  are both built (§4); the customer-app credential-issuance UI and a
  permanent E2E spec for the harness are not. The spec's own deliberate
  non-goals still apply (no real Flutter/NFC hardware integration, no
  staff remediation workflow for a fare journey the system couldn't
  price) that a future slice will need to pick up explicitly.
- Phase 5 Slices 1–2 (§6) are both built — a passenger can pay for a
  booking end to end — but no frontend consumer exists yet for any of
  it (no wallet/payment UI in `customer-app`), confirmed out of scope
  for the whole Phase 5 backend arc by the spec's own test plan.
  Settlement-run execution (payouts to operators) is Slice 3, spec'd
  but not built — a Business's clearing-account balance accumulates
  with nowhere to go yet.
