"""Passenger activity feed — docs/specs/20-live-operations.md slice 4.

Composes across `apps.payments` (`PaymentIntent`), `apps.ticketing`
(`Ticket`) and `apps.tapngo` (`FareJourney`) into one reverse-
chronological list for one signed-in passenger. No models of its own —
a read layer, the `apps.wallet`/`apps.analytics` shape.

Two named deviations from the spec's own wording, checked against the
model rather than guessed (docs/traps.md: "A spec can name fields that
do not exist"):

- **"Fare deducted (from FareJourney and ledger lines)"** implies a PAYG
  fare charge posts a ledger entry against the passenger's wallet. It
  does not: closing a `FareJourney`
  (`apps.tapngo.services._record_alight`) only stamps
  `FareJourney.amount`/`currency` — no `JournalEntry` is ever posted for
  it, so a PAYG ride today never actually touches the passenger's
  wallet balance. `fare_deducted` entries below are sourced from
  `FareJourney` alone and always carry `wallet_balance: None` — an
  honest account of what the system does today, not an invented ledger
  line.
- **"Ticket issued and boarded"** is one bullet naming two events,
  folded into one here. A `Ticket` is issued at the same instant its
  `Booking` is paid (`apps.booking.services.mark_booking_paid`), and a
  `booking_paid` entry already exists for that moment — a second
  "N tickets issued" row per booking (one per seat, per
  `docs/specs/10-booking-modes.md`) would repeat the same purchase as
  noise. `ticket_boarded` stays its own entry: it happens later, at
  scan time, and is genuinely new information a passenger did not
  already see in `booking_paid`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from apps.identity.models import User
from apps.ledger.models import JournalLine, LedgerAccount
from apps.payments.models import PaymentIntent
from apps.tapngo.models import FareJourney
from apps.ticketing.models import Ticket

_EntryType = str


@dataclass
class ActivityEntry:
    type: _EntryType
    occurred_at: datetime
    business: str
    route: str | None
    reference: str | None
    amount: Decimal | None
    currency: str | None
    wallet_balance: Decimal | None


def _wallet_accounts(passenger: User) -> list[LedgerAccount]:
    return list(
        LedgerAccount.objects.filter(
            passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
        )
    )


def _wallet_balances_after_by_line_id(accounts: list[LedgerAccount]) -> dict[str, Decimal]:
    """Every wallet `JournalLine`'s running balance, keyed by line id.

    ADR-0006's balance is derived, never stored, so a per-transaction
    "balance after" for a feed has no column to read and must be
    recomputed from the account's full history — bounded by one
    passenger's own transaction count, not the platform's, which is
    what makes doing this in Python acceptable here where it would not
    be for a fleet-wide read.
    """
    balances: dict[str, Decimal] = {}
    for account in accounts:
        running = Decimal("0.00")
        for line in JournalLine.objects.filter(account=account).order_by("created_at", "id"):
            running += line.amount
            balances[str(line.id)] = running
    return balances


def _wallet_line_by_entry_id(
    accounts: list[LedgerAccount], entry_ids: list[Any]
) -> dict[str, JournalLine]:
    if not accounts or not entry_ids:
        return {}
    lines = JournalLine.objects.filter(account__in=accounts, journal_entry_id__in=entry_ids)
    return {str(line.journal_entry_id): line for line in lines}


def list_activity(*, passenger: User, limit: int = 30) -> list[ActivityEntry]:
    """The passenger's own most recent activity, newest first, capped at
    `limit` — a feed, not a full statement. Each source query is itself
    capped at `limit` before merging, so a passenger with heavy PAYG use
    cannot force an unbounded `Ticket`/`FareJourney` scan just to find
    the newest wallet top-up."""
    entries: list[ActivityEntry] = []

    intents = list(
        PaymentIntent.objects.filter(passenger=passenger, status=PaymentIntent.Status.SUCCEEDED)
        .select_related("business", "booking__trip__route", "journal_entry")
        .order_by("-succeeded_at")[:limit]
    )
    accounts = _wallet_accounts(passenger)
    entry_ids = [intent.journal_entry_id for intent in intents if intent.journal_entry_id]
    wallet_line_by_entry = _wallet_line_by_entry_id(accounts, entry_ids)
    balance_after = _wallet_balances_after_by_line_id(accounts)

    for intent in intents:
        # Guaranteed by the `status=SUCCEEDED` filter above — every path
        # that sets that status sets this in the same write
        # (`_apply_booking_payment`, `_apply_wallet_topup`,
        # `pay_booking_from_wallet`).
        assert intent.succeeded_at is not None
        wallet_line = wallet_line_by_entry.get(str(intent.journal_entry_id))
        wallet_balance = balance_after.get(str(wallet_line.id)) if wallet_line else None
        if intent.intent_type == PaymentIntent.IntentType.WALLET_TOPUP:
            entries.append(
                ActivityEntry(
                    type="wallet_topup",
                    occurred_at=intent.succeeded_at,
                    business=intent.business.name,
                    route=None,
                    reference=None,
                    amount=intent.amount,
                    currency=intent.currency,
                    wallet_balance=wallet_balance,
                )
            )
        else:
            booking = intent.booking
            entries.append(
                ActivityEntry(
                    type="booking_paid",
                    occurred_at=intent.succeeded_at,
                    business=intent.business.name,
                    route=booking.trip.route.name if booking else None,
                    reference=booking.reference if booking else None,
                    amount=intent.amount,
                    currency=intent.currency,
                    # `None` unless this specific payment actually drew
                    # from the wallet — a pure-Paystack booking payment
                    # never touches it, and showing a balance beside a
                    # payment that did not move it would misattribute
                    # the change to the wrong row.
                    wallet_balance=wallet_balance,
                )
            )

    tickets = (
        Ticket.objects.filter(
            booking__passenger=passenger, status=Ticket.Status.BOARDED, boarded_at__isnull=False
        )
        .select_related("trip__route", "trip__business", "booking")
        .order_by("-boarded_at")[:limit]
    )
    for ticket in tickets:
        entries.append(
            ActivityEntry(
                type="ticket_boarded",
                occurred_at=ticket.boarded_at,  # type: ignore[arg-type]
                business=ticket.trip.business.name,
                route=ticket.trip.route.name,
                reference=ticket.booking.reference,
                amount=None,
                currency=None,
                wallet_balance=None,
            )
        )

    journeys = (
        FareJourney.objects.filter(passenger=passenger, status=FareJourney.Status.CLOSED)
        .select_related("trip__route", "business")
        .order_by("-alighted_at")[:limit]
    )
    for journey in journeys:
        entries.append(
            ActivityEntry(
                type="fare_deducted",
                occurred_at=journey.alighted_at,  # type: ignore[arg-type]
                business=journey.business.name,
                route=journey.trip.route.name,
                reference=None,
                # A deduction, shown negative — matches the sign
                # convention `JournalLine.amount` already uses for a
                # debit, even though this is not itself a ledger line.
                amount=-journey.amount if journey.amount is not None else None,
                currency=journey.currency or None,
                wallet_balance=None,
            )
        )

    entries.sort(key=lambda entry: entry.occurred_at, reverse=True)
    return entries[:limit]
