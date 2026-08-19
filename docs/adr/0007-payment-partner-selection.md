# ADR-0007: Payment partner selection

Status: **Accepted.** Confirmed directly with the product owner
(2026-08-14) as the payment partner Phase 5 (Payments, Wallet, Ledger)
integrates against first. This unblocks Phase 5 spec work per
`docs/status-report-2026-08-14.md` §7; the ledger chart-of-accounts
(ADR-0006) is the phase's other blocker and is finalized separately.

## Context

Phase 5 needs a payment service provider (PSP) decided before its spec
can be written — settlement timing, refund/chargeback semantics, fee
structure, and webhook/reconciliation shape all come from the PSP's own
API, not from this platform's preferences, and retrofitting a second
PSP's assumptions into an already-built data model is exactly the kind
of rework this ADR process exists to avoid (`docs/executive-overview.md`
§3). Integra's current operator roster spans Nigeria (Lagos commuter
shuttle, intercity bus) and Botswana (metro), so PSP country coverage is
a real constraint, not a formality.

## Decision

**Paystack** is the Phase 5 payment partner for Nigeria-based operators.

Paystack's supported markets are Nigeria, South Africa, Ghana, Kenya,
and Côte d'Ivoire, with Egypt and Rwanda in beta as of this writing
(sources below) — **Botswana is not among them.** This was surfaced
explicitly before this decision was confirmed, not discovered
afterward. The product owner's explicit call: proceed with Paystack now
for the operators it does serve, and treat Botswana as a **named,
open gap** rather than either blocking Phase 5 on it or quietly
building as if it didn't exist.

## What remains open

- **A second PSP for Botswana** (candidates raised during this
  decision: DPO Group / Network International, which has deep
  Southern/East Africa coverage including Botswana; Flutterwave, which
  has broader pan-African coverage but less Nigeria-specific depth than
  Paystack). Not decided — deferred until the Botswana metro operator
  is actually being brought onto payments, not before.
- Until a second PSP is integrated, the Botswana metro `Business` can
  exist and run bookings (Phase 4 already supports this — tap-and-go
  fare determination, ADR pending as of this writing, doesn't require
  payment at all), but cannot go live on Phase 5 payment collection.
  Phase 5's spec must make this an explicit precondition/guard, not an
  assumption baked in silently — e.g. a `Business` without a configured
  PSP account should fail closed on any payment-initiation endpoint
  with a clear error, not a generic 500.
- Exact Phase 5 data-model shape against Paystack's specific API
  (transaction initialization, webhook signature verification, transfer/
  payout API for settlement) is Phase 5 spec work, not this ADR's job —
  this ADR settles *which* partner, not the integration's shape.

## Options considered

- **Flutterwave.** Broadest single-integration pan-African coverage
  (30+ countries, including Botswana) — would have covered both
  operators from day one. Rejected in favor of Paystack per the product
  owner's explicit choice; noted here as the strongest fallback
  candidate if Nigeria-Botswana single-PSP coverage becomes a hard
  requirement later.
- **DPO Group (Network International).** Strong Southern/East Africa
  coverage including Botswana, weaker as a single integration for
  Nigeria specifically. Rejected for the same reason as Flutterwave —
  product owner chose Paystack — but is the leading candidate for the
  "second PSP for Botswana" work item above, precisely because its
  strength (Southern Africa) is Paystack's gap.
- **Stripe.** Not seriously evaluated — Stripe's direct African market
  support is materially weaker than any of the above for this
  platform's actual operator roster.

## Consequences

- `apps/payments` (Phase 5) is built against Paystack's transaction
  API, webhook format, and settlement model as its first and, for now,
  only PSP integration — but should not hardcode a single-PSP
  assumption so deeply that adding a second one later requires a
  rewrite rather than an addition (e.g. a `Business`-level PSP-account
  reference rather than a global singleton config).
- The Botswana metro operator's path to live payments is explicitly
  gapped, tracked here and in `docs/status-report-2026-08-14.md`, not
  silently deferred.

Sources checked for Paystack's country coverage: [Paystack —
Countries](https://paystack.com/countries), [Paystack Blog — Virtual
Terminal expansion](https://paystack.com/blog/product/virtual-terminal-expansion),
[Paystack Blog — Côte d'Ivoire, Egypt, Rwanda
beta](https://paystack.com/blog/company-news/civ-rwanda-egypt-beta).
