"""Thin read layer over apps.ledger — see
docs/specs/5-payments-wallet-ledger.md's "apps/wallet (Slice 2)"
section. No balance-bearing model of its own: a "wallet" is not, per
docs/adr/0006, a financial primitive distinct from
`LedgerAccount(account_type="wallet")` — inventing a parallel model
with its own `balance` field would violate the ADR's own "balance is
always derived... never stored as an authoritative mutable field"
principle.
"""

from decimal import Decimal
from typing import TypedDict

from apps.businesses.models import Business
from apps.identity.models import User
from apps.ledger.models import JournalLine, LedgerAccount


class WalletBalance(TypedDict):
    balance: Decimal
    currency: str


def get_wallet_balance(*, passenger: User, business: Business) -> WalletBalance:
    """Read-only — deliberately does NOT call
    `apps.ledger.services.get_or_create_wallet_account()` (that writes a
    row). A passenger who's never paid for anything shouldn't cause a
    `LedgerAccount` row to exist just from viewing their own empty
    wallet."""
    account = LedgerAccount.objects.filter(
        business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
    ).first()
    balance = account.cached_balance if account is not None else Decimal("0.00")
    return {
        "balance": balance if balance is not None else Decimal("0.00"),
        "currency": business.currency,
    }


def list_wallet_transactions(*, passenger: User, business: Business) -> list[JournalLine]:
    account = LedgerAccount.objects.filter(
        business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
    ).first()
    if account is None:
        return []
    return list(JournalLine.objects.filter(account=account).order_by("-created_at"))
