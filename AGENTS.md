# AGENTS.md

Index for agents and contributors working in this repo. Short on purpose —
[`CLAUDE.md`](CLAUDE.md) is the deep source of truth for conventions, known
limitations, and the gotchas worth knowing before you touch anything.

## What this is

Integra AFC — an Automated Fare Collection platform for African transport
operators (Lagos commuter shuttle, intercity bus, Botswana metro). One
Django/DRF backend; four white-labeled Angular 20 frontends (customer,
client-admin, super-admin, validator) sharing libraries in one Angular
CLI workspace.

**Current status**: Phases 0–4 complete and self-checked, including Phase 4's
frontend addendum (customer-app booking flow, client-admin bookings-list) and
a separately-documented fare-versioning/price-snapshot addendum — see
[`CLAUDE.md`](CLAUDE.md) and
[`docs/self-check-2026-08-14-phase4-frontend.md`](docs/self-check-2026-08-14-phase4-frontend.md)
for the full account, including a process gap worth knowing about: both
addenda were built without the working agreement's stop-and-review
checkpoints and verified retroactively. Phase 5 (Payments, Wallet,
Ledger)'s two blockers — payment partner ([`docs/adr/0007`](docs/adr/0007-payment-partner-selection.md),
Paystack) and ledger design ([`docs/adr/0006`](docs/adr/0006-ledger-chart-of-accounts.md),
now Accepted) — are both resolved, and **Phase 5 is now spec'd in
full** ([`docs/specs/5-payments-wallet-ledger.md`](docs/specs/5-payments-wallet-ledger.md))
with **all three backend slices built and self-checked — Phase 5's
backend arc is complete**: Slice 1, the ledger foundation
(`apps/ledger`); Slice 2, actual Paystack payment initiation + webhook
handling (`apps/payments`, `apps/wallet`, `Booking.Status.PAID`) — a
passenger can now pay for a booking end to end; and Slice 3, settlement
runs (`apps.ledger.services.claim_settlement_run()`,
`apps.payments.services.trigger_settlement_run()`, a
`transfer.success`/`transfer.failed` webhook extension) — platform
staff can now trigger a real Paystack payout of an operator's
accumulated balance. The working agreement's stop-and-review checkpoint
was honored between all three slices. Real, non-obvious bugs were found
only by running each slice's flow under real conditions, never by
static review: Slice 2 found two (a `Model.save()` manager-targeting
bug latent since Slice 1, and a `platform_staff_bypass()` nesting bug);
Slice 3 found one (`trigger_settlement_run()` only worked because its
one real caller, the HTTP endpoint, happened to already have an RLS
bypass active — broken when called directly, the way a future scheduled
job would). See the spec's own "Implementation note" for each slice for
the full account. **Phase 5's frontend is now complete, all three
slices, one app at a time with a review checkpoint between each**:
Slice A gave customer-app a "Pay now" action on `my-bookings`; Slice B
gave client-admin-app read-only Payments/Ledger/Wallet Lookup
visibility screens (plus a new `ui-stat` shared component); Slice C
gave super-admin-app Paystack account config + settlement-run trigger
UI, needing two small backend additions along the way (`GET /super-admin/businesses/`,
a cross-client Business search platform staff had no way to do before;
and a `GET` added to the previously PATCH-only Paystack account config
endpoint). 480/480 backend tests passing (up from 470). See the spec's
own "Implementation note" for each frontend slice. **Phase 4b
(tap-and-go fare determination) is now fully complete** —
[`docs/specs/4b-tap-and-go.md`](docs/specs/4b-tap-and-go.md) (see its
four Implementation notes) — `apps/tapngo`, `validator-app` (a fourth
installable-PWA Angular app), a `credentials` screen in `customer-app`
(issue/view/revoke a `TapCredential`, this workspace's first
QR-rendering code, needing no backend change since the three
`tap-credentials` endpoints it uses were already
customer-app-consumable), and — the last remaining piece, closed out
the same day — a permanent Playwright spec for validator-app's `record`
screen (`frontend/e2e/validator-app/`), which needed a
`playwright.config.ts` entry for the app plus a `seed_e2e_users`
extension seeding its own tap-and-go-mode Business/Trip and a
`TapCredential` with a known fixed token (the real issuance flow never
persists a raw token, so nothing else could supply one). 470/470 backend
tests passing (up from 383 before Phase 5). See
[`docs/status-report-2026-08-17.md`](docs/status-report-2026-08-17.md) for the
current report.

## Where to look

| Question | File |
| --- | --- |
| Conventions, commands, gotchas | [`CLAUDE.md`](CLAUDE.md) |
| How the system is designed | [`docs/architecture.md`](docs/architecture.md) |
| Non-technical overview | [`docs/executive-overview.md`](docs/executive-overview.md) |
| What "done" means | [`docs/self-check.md`](docs/self-check.md) |
| Approved specs per phase | [`docs/specs/`](docs/specs/) |
| Load-bearing decisions | [`docs/adr/`](docs/adr/) |
| Local login credentials | [`docs/test-accounts.md`](docs/test-accounts.md) |

Cursor project rules live in [`.cursor/rules/`](.cursor/rules/) and load
automatically — the workflow rule always, the backend and frontend rules when
you open matching files.

## How we work

Spec before code. ADRs for architectural decisions. Thinnest vertical slice
first, then stop for review. Never guess on ambiguity — label unavoidable
assumptions `ASSUMPTION:`. Self-check before declaring anything done.

## Session hygiene

Long sessions degrade as the context window fills. Before that happens:

1. Run `/handoff` to write a durable summary of goal, decisions, and next steps
   into the chat.
2. Run `/summarize` to compact the conversation and keep working in the same
   chat. `/compress` and `/compact` are aliases.

Use `/clear` (aliases `/new`, `/new-chat`) only when switching to unrelated
work — it discards history rather than compacting it.
