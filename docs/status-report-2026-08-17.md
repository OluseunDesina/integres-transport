# Integra AFC — Engineering Status — 2026-08-17

**Audience**: project stakeholders with a technical background — enough
to read a phase plan and an architectural decision, not necessarily
enough to read the code.

**Purpose**: state what is built, what is being built, what is
deliberately not being built yet, and what decision is currently
blocking the project. Companion to `docs/architecture.md`. Supersedes
`docs/status-report-2026-08-14.md`.

---

## 1. Where we are

**Phase 5's backend is now fully complete.** All three planned backend
slices — the ledger foundation, real Paystack payment initiation +
webhook handling, and settlement runs (paying an operator out) — are
built, self-checked, and stopped for review between each one, the same
discipline this project committed to after Phase 4's process slip
(2026-08-14 report, §2–3). A passenger can pay for a booking end to
end, and Integra's platform staff can now trigger a real payout of a
Business's accumulated clearing balance through Paystack's Transfer
API.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation, tenancy, CI, auth skeleton | Complete, self-checked |
| 1 | Identity, Client, Business, RBAC | Complete, self-checked |
| 2 | Client-admin + super-admin consoles | Complete, self-checked |
| 3 | Network, Scheduling, Fleet | Complete, self-checked |
| 4 | Fares, Seating, Booking (backend + frontend) | Complete, self-checked |
| 4v | Fare versioning + price snapshotting | Complete, self-checked |
| 4b | Tap-and-go fare determination | Backend + operator harness built; customer-app credential UI not yet built |
| 5 | Payments, Wallet, Ledger | **Backend complete — all 3 slices built and self-checked (§2).** No frontend consumer yet |
| 6 | QR ticketing + validator | Unblocked technically; sequenced after Phase 5 |

## 2. Shipped since the last report: Slice 3 — settlement runs

Spec'd in full alongside Slices 1–2 on 2026-08-16
(`docs/specs/5-payments-wallet-ledger.md`); built this pass, closing
Phase 5's backend arc.

**What it does**: platform staff trigger a payout
(`POST /settlement-runs/`, `IsPlatformStaff`-gated — deliberately *not*
a Role/Permission codename, since a payout is a platform financial
operation, not something an operator triggers on itself) for one
Business over one period. Triggering atomically claims every
not-yet-paid-out `JournalEntry` in that window, snapshots the payout
total from those entries' clearing-account lines, and calls Paystack's
Transfer API to actually move the money. A new
`transfer.success`/`transfer.failed` extension to the existing webhook
handler reconciles the outcome — `paid_out` or `failed` — the same way
the Slice 2 handler already reconciles `charge.success`/`charge.failed`
against a `PaymentIntent`.

**Two concurrency guarantees, both proven, not assumed**: two staff
members can't trigger duplicate payouts for the same Business/period
(a database constraint rejects the second attempt outright), and no
single payment can ever be paid out twice or left out of every payout
— both proven under real concurrent racing with a dedicated stress
test (8 simultaneous attempts at the identical duplicate payout, run
repeatedly), the same standard every money-moving piece of this system
has been held to since Phase 4.

**Three sensible defaults, decided up front rather than guessed
mid-build**: an operator with no payout bank details configured yet
fails closed with a clear error, the same pattern already used
elsewhere in this phase for "not set up yet" rather than a generic
server error; a payout period with genuinely nothing owed is marked
settled immediately with no live payment call, rather than sending a
payment for zero; and a payout period is anchored to the operator's own
local timezone. None of these needed a stakeholder decision — each is
a narrow, reviewable default a reader can veto without re-deriving the
whole design, unlike Slice 2's commission-rate gap, which genuinely did
need the product owner's input.

**One real bug found and fixed — again, only by running the code, not
by reading it**: the new payout-trigger logic worked correctly through
its real web endpoint, but failed silently when called directly the
way an unattended, scheduled version of this feature would eventually
need to run (a nightly job, for instance) — it would have seen zero
configured payout accounts even for correctly set up operators. The
web endpoint happened to mask this because of a security safeguard
that was already active for unrelated reasons whenever a staff member
used it directly. Traced to its root and fixed so the underlying
function no longer depends on being called a particular way. Full
technical detail in the spec's own "Implementation note (Slice 3,
done)" section.

21 new tests (470/470 backend-wide, up from 449); `ruff`/`mypy`/
`makemigrations --check`/OpenAPI-drift all clean; no new database
migration was needed — the relevant table already existed from the
ledger foundation built in Slice 1, unused until now.

## 3. Architectural decisions

No change since the last report. ADR-0006 (ledger chart-of-accounts)
and ADR-0007 (Paystack as payment partner) remain **Accepted**; ADR-0004
(seat-segment concurrency) remains **Accepted**; ADR-0005 (QR ticket
signing) remains **Proposed**, gating Phase 6 only.

## 4. Still deferred

**A second PSP for Botswana.** Named and tracked since ADR-0007; not
needed until that operator is actually brought onto payments. Still
the single largest named gap in this phase — a real operator on this
platform genuinely cannot collect or be paid money today.

**Transaction history and reporting dashboards for operators.** The
data behind them (the ledger, now including settlement runs) is
complete; no staff-facing screen surfaces it yet.

**Any frontend consumer for Phase 5 at all.** Confirmed out of scope
for the whole Phase 5 backend arc from the start (the spec's own test
plan) — everything in this phase, across all three slices, has been
verified directly against the system, not through a UI. Building that
UI is separate, upcoming work.

**QR ticketing and the Flutter validator app.** Design is settled;
sequenced after payments.

## 5. What we need from stakeholders

Nothing new is blocking. The one open, tracked item from the last
report is unchanged:

- **A second PSP for the Botswana metro operator**, since Paystack
  doesn't cover that market. Not needed until that operator is actually
  brought onto payments — DPO Group is the leading candidate per
  ADR-0007's "options considered."

The natural next conversation, now that Phase 5's backend is done, is
**when to build its frontend** (a passenger-facing payment/wallet
screen, staff-facing settlement visibility) versus moving straight to
Phase 6 (ticketing) — a sequencing choice, not a blocker.

## 6. Known gaps, for completeness

- The repository still has zero git commits — everything described in
  this report, across every phase, exists only in a local working tree.
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
  outrunning an unpaginated `limit=100` picker) remains present and
  not fixed, per the same reasoning as when it was first found.
- The Botswana metro operator still cannot go live on Phase 5 payments —
  Paystack, the chosen partner, doesn't operate there (§3, §5). Named
  and tracked, not silently deferred.
- Phase 4b (tap-and-go) backend and operator harness (`validator-app`)
  are both built; the customer-app credential-issuance UI and a
  permanent E2E spec for the harness are not.
- Phase 5's backend is now fully built across all three slices (§2) —
  but no frontend consumer exists yet for any of it (no wallet/payment/
  settlement UI anywhere), confirmed out of scope for the whole backend
  arc by the spec's own test plan. A `SettlementRun` marked `failed`
  (a rejected Paystack transfer) has no retry mechanism yet — flagged
  in the spec as a deliberate, not-yet-solved gap.
