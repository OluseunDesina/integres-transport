"""Fat-service layer for apps.ledger — see docs/adr/0006 and
docs/specs/5-payments-wallet-ledger.md.

`post_journal_entry` is the sole write path for `JournalEntry`/
`JournalLine` rows (ADR-0006's own "enforced by [a] test, not just
application logic" requirement) and the only place a `LedgerAccount`'s
`cached_balance` is updated. Every function here runs under
`apps.core.rls.platform_staff_bypass()`, using `LedgerAccount.all_objects`
throughout: a single journal entry can legitimately span two different
Clients' books at once (a Business's clearing-account credit and the
platform-level Integra commission-account credit, in the same
three-line entry ADR-0006 requires), and these functions must also work
with no ambient tenancy context at all — a Paystack webhook (Phase 5
Slice 2) has no authenticated request behind it, the same reason
`apps.seating.tasks.expire_seat_holds` reaches for this. This is the
same kind of deliberate cross-tenant write `apps.core.audit.record_audit_event`
already makes for `AuditLog`, not a bypass of tenancy so much as a
recognition that these operations were never scoped to one tenant in
the first place.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from apps.businesses.models import Business
from apps.clients.models import Client
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.identity.models import User

from .models import JournalEntry, JournalLine, LedgerAccount, SettlementRun


class UnbalancedJournalEntry(Exception):
    """The given lines' amounts don't sum to zero, or no lines were
    given — rejected before any DB write, never a database-level
    failure. ADR-0006's balance invariant is enforced here in
    application code and independently re-verified by a DB-wide sweep
    test, not by a Postgres trigger."""


@dataclass(frozen=True)
class JournalLineInput:
    account: LedgerAccount
    amount: Decimal
    currency: str


def get_or_create_wallet_account(
    *, client: Client, business: Business, passenger: User
) -> LedgerAccount:
    with platform_staff_bypass():
        account, created = LedgerAccount.all_objects.get_or_create(
            business=business,
            passenger=passenger,
            account_type=LedgerAccount.AccountType.WALLET,
            defaults={"client": client, "cached_balance": Decimal("0.00")},
        )
        if created:
            record_audit_event(
                actor=None,
                action="ledger_account.created",
                target=account,
                client_id=str(client.id),
                account_type=LedgerAccount.AccountType.WALLET,
            )
    return account


def get_or_create_business_clearing_account(*, client: Client, business: Business) -> LedgerAccount:
    with platform_staff_bypass():
        account, created = LedgerAccount.all_objects.get_or_create(
            business=business,
            account_type=LedgerAccount.AccountType.BUSINESS_CLEARING,
            defaults={"client": client, "cached_balance": Decimal("0.00")},
        )
        if created:
            record_audit_event(
                actor=None,
                action="ledger_account.created",
                target=account,
                client_id=str(client.id),
                account_type=LedgerAccount.AccountType.BUSINESS_CLEARING,
            )
    return account


def get_or_create_refund_contra_account(*, client: Client, business: Business) -> LedgerAccount:
    with platform_staff_bypass():
        account, created = LedgerAccount.all_objects.get_or_create(
            business=business,
            account_type=LedgerAccount.AccountType.REFUND_CONTRA,
            defaults={"client": client, "cached_balance": Decimal("0.00")},
        )
        if created:
            record_audit_event(
                actor=None,
                action="ledger_account.created",
                target=account,
                client_id=str(client.id),
                account_type=LedgerAccount.AccountType.REFUND_CONTRA,
            )
    return account


def get_or_create_psp_suspense_account(
    *, client: Client, business: Business, provider: str
) -> LedgerAccount:
    """Not written to by anything this phase (see the spec's non-goals)
    — provided now because the account type is part of the fixed
    taxonomy from this slice's first migration, and every account type
    in that taxonomy gets a constructor, not just the ones a caller
    happens to need yet."""
    with platform_staff_bypass():
        account, created = LedgerAccount.all_objects.get_or_create(
            business=business,
            psp_provider=provider,
            account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
            defaults={"client": client, "cached_balance": Decimal("0.00")},
        )
        if created:
            record_audit_event(
                actor=None,
                action="ledger_account.created",
                target=account,
                client_id=str(client.id),
                account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
                psp_provider=provider,
            )
    return account


def get_or_create_commission_account() -> LedgerAccount:
    """The single platform-level `integra_commission` row. Seeded by
    `apps/ledger/migrations/0002_seed_integra_commission_account.py` in
    normal operation — this function exists so callers (chiefly
    `post_journal_entry`) never have to special-case "what if it hasn't
    been seeded yet" (e.g. in a test that doesn't run migrations)."""
    with platform_staff_bypass():
        account, created = LedgerAccount.all_objects.get_or_create(
            account_type=LedgerAccount.AccountType.INTEGRA_COMMISSION,
            defaults={"client": None, "cached_balance": Decimal("0.00")},
        )
        if created:
            record_audit_event(
                actor=None,
                action="ledger_account.created",
                target=account,
                account_type=LedgerAccount.AccountType.INTEGRA_COMMISSION,
            )
    return account


def post_journal_entry(
    *,
    business: Business,
    entry_type: str,
    lines: list[JournalLineInput],
    external_reference: str = "",
    memo: str = "",
    actor: User | None = None,
) -> JournalEntry:
    """The sole write path for `JournalEntry`/`JournalLine` rows. Raises
    `UnbalancedJournalEntry` before any write if `lines` is empty or
    doesn't sum to zero. Locks every touched `LedgerAccount` in a stable
    order (by primary key) before updating `cached_balance`, so two
    concurrent entries touching an overlapping set of accounts can't
    deadlock each other."""
    if not lines:
        raise UnbalancedJournalEntry("A journal entry must have at least one line.")
    total = sum((line.amount for line in lines), Decimal("0.00"))
    if total != Decimal("0.00"):
        raise UnbalancedJournalEntry(f"Journal entry lines must sum to zero, got {total}.")

    with platform_staff_bypass(), transaction.atomic():
        account_ids = sorted({str(line.account.id) for line in lines})
        locked_accounts = {
            str(account.id): account
            for account in LedgerAccount.all_objects.select_for_update().filter(id__in=account_ids)
        }
        entry = JournalEntry.all_objects.create(
            client=business.client,
            business=business,
            entry_type=entry_type,
            external_reference=external_reference,
            memo=memo,
        )
        for line in lines:
            JournalLine.all_objects.create(
                client=business.client,
                journal_entry=entry,
                account=line.account,
                amount=line.amount,
                currency=line.currency,
            )
            account = locked_accounts[str(line.account.id)]
            account.cached_balance = (account.cached_balance or Decimal("0.00")) + line.amount
            account.cached_balance_updated_at = timezone.now()
            account.save(update_fields=["cached_balance", "cached_balance_updated_at"])

    record_audit_event(
        actor=actor,
        action="ledger.journal_entry_posted",
        target=entry,
        client_id=str(business.client_id),
        entry_type=entry_type,
        total_lines=len(lines),
    )
    return entry


class SettlementRunAlreadyExists(Exception):
    """A `SettlementRun` for this exact `(business, period_start,
    period_end)` already exists — mapped to 409 by
    `apps.payments.services.trigger_settlement_run`. DB-enforced by
    `unique_settlement_run_per_business_period`, never pre-checked
    (Phase 5 Slice 3 spec, edge case 10)."""


def claim_settlement_run(
    *, business: Business, period_start: date, period_end: date, initiated_by: User
) -> SettlementRun:
    """Creates a new `SettlementRun` row and, in the same transaction,
    claims every currently-unclaimed `JournalEntry` for `business`
    whose `created_at` falls in the half-open window
    `[period_start, period_end)` by bulk-assigning them to it — a
    `.filter(settlement_run__isnull=True).update(...)`, never a
    per-row check-then-write (edge case 11's "a normal unique write"
    reasoning, ADR-0006). `total_amount` is snapshotted as
    `SUM(JournalLine.amount)` against the Business's
    `business_clearing` account among just-claimed entries only, so it
    reflects what's actually owed, not every line on those entries
    (the wallet-debit and commission-credit lines net out elsewhere).

    Raises `SettlementRunAlreadyExists` before claiming anything if the
    `(business, period)` row collides with an existing one.

    ASSUMPTION: `period_start`/`period_end` are anchored to
    `business.timezone`, converted to timezone-aware datetime bounds
    the same way `apps.scheduling.services` already does for its own
    date-to-datetime boundary — the spec doesn't name which timezone a
    settlement period is anchored to."""
    period_start_dt = datetime.combine(period_start, time.min, tzinfo=ZoneInfo(business.timezone))
    period_end_dt = datetime.combine(period_end, time.min, tzinfo=ZoneInfo(business.timezone))

    with platform_staff_bypass(), transaction.atomic():
        try:
            run = SettlementRun.all_objects.create(
                client=business.client,
                business=business,
                period_start=period_start,
                period_end=period_end,
                initiated_by=initiated_by,
                total_amount=Decimal("0.00"),
                currency=business.currency,
            )
        except IntegrityError:
            raise SettlementRunAlreadyExists(
                "A settlement run for this business and period already exists."
            ) from None

        JournalEntry.all_objects.filter(
            business=business,
            settlement_run__isnull=True,
            created_at__gte=period_start_dt,
            created_at__lt=period_end_dt,
        ).update(settlement_run=run)

        clearing_account = get_or_create_business_clearing_account(
            client=business.client, business=business
        )
        total = (
            JournalLine.all_objects.filter(
                account=clearing_account, journal_entry__settlement_run=run
            ).aggregate(total=Sum("amount"))["total"]
            or Decimal("0.00")
        )
        run.total_amount = total
        run.save(update_fields=["total_amount"])

    record_audit_event(
        actor=initiated_by,
        action="ledger.settlement_run_claimed",
        target=run,
        client_id=str(business.client_id),
        total_amount=str(run.total_amount),
    )
    return run
